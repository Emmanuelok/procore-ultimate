/**
 * DataTable — the grid the whole product is built on.
 *
 * ARCHITECTURE
 * ------------
 * TanStack Table v9 owns the *model* (sort / filter / group / expand / paginate
 * / select / size / pin / order). TanStack Virtual owns the *geometry*. This
 * file owns the *rendering*, the *keyboard*, and the *chrome* — and nothing
 * else. That split is why 50,000 rows scroll at 60fps: only ~25 rows are ever
 * in the DOM, and the model is memoised inside the engine.
 *
 * The markup is a `role="grid"` built from divs rather than a `<table>`. A real
 * table cannot do sticky pinned columns, sub-pixel column resizing and absolute
 * row positioning at the same time; the ARIA grid pattern gives assistive tech
 * exactly the same semantics.
 *
 * LAYOUT
 * ------
 *   scroll container            overflow:auto, the only scroller
 *     └ sized track             width = table.getTotalSize(), role="grid"
 *         ├ sticky header block band row + header row + filter row
 *         ├ body rowgroup       height = virtualizer.getTotalSize()
 *         └ sticky footer       aggregates
 *
 * Pinned cells are `position: sticky` with offsets from the engine, so they
 * pin against the scroll container in both axes without any JS on scroll.
 */
import {
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
import { functionalUpdate, useTable } from "@tanstack/react-table";
import type {
  ColumnFiltersState,
  Header,
  ColumnOrderState,
  ColumnPinningState,
  ColumnSizingState,
  ColumnVisibilityState,
  ExpandedState,
  GroupingState,
  PaginationState,
  RowSelectionState,
  SortingState,
  Updater,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cx } from "../cx";
import {
  IconArrowDown,
  IconArrowUp,
  IconClose,
  IconDensity,
  IconDownload,
  IconEyeOff,
  IconFilterAdjust,
  IconGroup,
  IconMore,
  IconPin,
  IconRefresh,
  IconRuler,
  IconSlash,
  IconTableView,
} from "../icons";
import { Button, Checkbox, EmptyState, ErrorAlert, IconButton, Spinner } from "../primitives";
import { DropdownMenu, MenuItem, MenuLabel, MenuSeparator, Popover, Tooltip } from "../overlays";
import { tone as toneStyles, Z_CLASS, type Density } from "../tokens";
import { DataToolbar } from "./DataToolbar";
import { FilterBuilderPopover } from "./FilterBuilder";
import { Pagination } from "./Pagination";
import { exportCsv, timestampSuffix } from "./csv";
import { useGridEditing } from "./editing";
import {
  aggregateValues,
  formatCurrency,
  formatNumber,
  formatPercent,
  toText,
} from "./format";
import {
  deriveOptions,
  evaluateFilterNode,
  filterFieldMap,
  filterFieldsFromColumns,
  filterKindFor,
  makeAccessor,
  pruneFilter,
} from "./filters";
import {
  ALIGN_CLASS,
  BooleanFilterControl,
  DENSITY_STYLE,
  ExpandToggle,
  OptionCheckList,
  RangeFilterControl,
  ResizeGrip,
  SkeletonRow,
  SortGlyph,
  TextFilterControl,
  csvValueFor,
  renderCellValue,
  renderIconLike,
  useControllableState,
  useElementWidth,
  useGlobalDensity,
  useMeasuredRowHeight,
} from "./internals";
import {
  ACTIONS_COLUMN_ID,
  SELECT_COLUMN_ID,
  aggregateFor,
  alignFor,
  buildColumnDefs,
  columnIdsOf,
  dataTableFeatures,
  defaultPinning,
  defaultRowId,
  defaultVisibility,
  headerTextOf,
  type DataRow,
  type DataTableFeatures,
  type DataTableInstance,
  type RowShape,
} from "./table-core";
import {
  loadActiveViewId,
  loadLayout,
  loadViews,
  makeViewId,
  saveActiveViewId,
  saveLayout,
  saveViews,
  viewStatesEqual,
} from "./views";
import type {
  DataBulkAction,
  DataCellContext,
  DataColumn,
  DataFilterGroup,
  DataRowAction,
  DataTableApi,
  DataTableHandle,
  DataTableProps,
  DataView,
  DataViewState,
} from "./types";

/* ========================================================================== */

const HEADER_ROW_CLASS = "flex w-full items-stretch";
const EMPTY_ARRAY: readonly never[] = [];

/**
 * The shadow a start-pinned column casts once the grid is scrolled sideways.
 * A directional box-shadow cannot be expressed with a semantic colour utility,
 * so the two themes are spelled out: a soft grey edge on light, a deeper one on
 * dark where a faint shadow would disappear into the surface.
 */
const PINNED_SCROLL_SHADOW =
  "shadow-[8px_0_10px_-8px_rgb(0_0_0/0.22)] dark:shadow-[10px_0_14px_-8px_rgb(0_0_0/0.75)]";
const EMPTY_ACTIONS: readonly never[] = [];

/** One leaf header from the engine, in display order (pinning applied). */
type GridHeader<T extends RowShape> = Header<DataTableFeatures, T, unknown>;

export type DataTableComponentProps<T> = DataTableProps<T> & {
  ref?: Ref<DataTableHandle<T>>;
};

export function DataTable<T extends RowShape>(props: DataTableComponentProps<T>): ReactElement {
  const {
    data,
    columns: userColumns,
    getRowId,
    getSubRows,
    tableId,

    loading = false,
    loadingRows = 8,
    error,
    onRetry,
    empty,
    emptyFiltered,

    height,
    maxHeight,
    fill = false,
    virtualized,
    virtualizeThreshold = 80,
    overscan = 12,
    rowHeight: rowHeightProp,
    stickyFooter = false,
    showFooter,
    density = "auto",
    zebra = false,
    gridLines = false,
    flush = false,
    className,
    style,
    caption,

    toolbar,
    toolbarActions,
    searchable = true,
    searchPlaceholder = "Search all columns…",
    columnPicker = true,
    densityToggle = true,
    filterBuilder = true,
    exportable = true,
    exportFileName,
    onExport,
    savedViews = true,
    builtInViews,

    sortable = true,
    defaultSort,
    sorting: sortingProp,
    onSortingChange,
    multiSort = true,
    manualSorting = false,

    filterRow = false,
    globalFilter: globalFilterProp,
    onGlobalFilterChange,
    columnFilters: columnFiltersProp,
    onColumnFiltersChange,
    advancedFilter: advancedFilterProp,
    onAdvancedFilterChange,
    manualFiltering = false,

    columnVisibility: visibilityProp,
    onColumnVisibilityChange,
    columnOrder: orderProp,
    onColumnOrderChange,
    columnPinning: pinningProp,
    onColumnPinningChange,
    columnSizing: sizingProp,
    onColumnSizingChange,
    resizableColumns = true,
    reorderableColumns = true,
    columnMenu = true,

    selectable = false,
    selectedIds,
    onSelectionChange,
    isRowSelectable,
    bulkActions,
    totalCount,
    onSelectAllAcross,
    allAcrossSelected = false,

    grouping: groupingProp,
    onGroupingChange,
    expanded: expandedProp,
    onExpandedChange,
    defaultExpanded,
    treeColumnId,

    paginated = false,
    pageSize: pageSizeProp = 50,
    pageSizeOptions,
    pageIndex: pageIndexProp,
    onPaginationChange,
    manualPagination = false,
    pageCount,

    onRowClick,
    onRowDoubleClick,
    rowHref,
    rowLabel,
    rowActions,
    rowClassName,
    rowTone,
    keyboardNavigation = true,

    editable = false,
    onCellEdit,
    onCommitEdits,
    bufferEdits = true,

    ref,
  } = props;

  const instanceId = useId();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const headerBlockRef = useRef<HTMLDivElement | null>(null);
  const probeRef = useRef<HTMLDivElement | null>(null);

  const selectionMode: false | "single" | "multi" =
    selectable === true ? "multi" : selectable === false || selectable === undefined ? false : selectable;

  /* ---------------------------------------------------------------- density */

  const globalDensity = useGlobalDensity();
  const [localDensity, setLocalDensity] = useState<Density | null>(
    density === "auto" ? null : density,
  );
  useEffect(() => {
    setLocalDensity(density === "auto" ? null : density);
  }, [density]);
  const resolvedDensity: Density = localDensity ?? globalDensity;
  const densityStyle = localDensity ? DENSITY_STYLE[localDensity] : undefined;

  /* ------------------------------------------------------- effective columns */

  const hasRowActions = Boolean(rowActions);
  const effectiveColumns = useMemo<Array<DataColumn<T, any>>>(() => {
    const list: Array<DataColumn<T, any>> = [];
    if (selectionMode) {
      list.push({
        id: SELECT_COLUMN_ID,
        header: "",
        headerText: "Select",
        width: 40,
        minWidth: 40,
        maxWidth: 40,
        sticky: "start",
        align: "center",
        hideable: false,
        resizable: false,
        sortable: false,
        filterable: false,
        interactive: true,
        exportable: false,
      });
    }
    list.push(...userColumns);
    if (hasRowActions) {
      list.push({
        id: ACTIONS_COLUMN_ID,
        header: "",
        headerText: "Actions",
        width: 52,
        minWidth: 44,
        maxWidth: 220,
        sticky: "end",
        align: "right",
        hideable: false,
        resizable: false,
        sortable: false,
        filterable: false,
        interactive: true,
        exportable: false,
      });
    }
    return list;
  }, [userColumns, selectionMode, hasRowActions]);

  const columnMap = useMemo(() => {
    const map = new Map<string, DataColumn<T, any>>();
    for (const column of effectiveColumns) map.set(column.id, column);
    return map;
  }, [effectiveColumns]);

  const allColumnIds = useMemo(() => columnIdsOf(effectiveColumns), [effectiveColumns]);

  /* --------------------------------------------------------------- persistence */

  const [persisted] = useState<DataViewState>(() => loadLayout(tableId) ?? {});
  const [storedViews, setStoredViews] = useState<DataView[]>(() => loadViews(tableId));
  const [activeViewId, setActiveViewId] = useState<string | null>(() => loadActiveViewId(tableId));

  const views = useMemo<DataView[]>(
    () => [...(builtInViews ?? []), ...storedViews],
    [builtInViews, storedViews],
  );

  /* --------------------------------------------------------------- table state */

  const [sorting, setSorting] = useControllableState<SortingState>(
    sortingProp as SortingState | undefined,
    (persisted.sorting ?? defaultSort ?? EMPTY_ARRAY) as SortingState,
    onSortingChange as ((next: SortingState) => void) | undefined,
  );

  const [columnFilters, setColumnFilters] = useControllableState<ColumnFiltersState>(
    columnFiltersProp as ColumnFiltersState | undefined,
    (persisted.columnFilters ?? EMPTY_ARRAY) as ColumnFiltersState,
    onColumnFiltersChange as ((next: ColumnFiltersState) => void) | undefined,
  );

  const [globalFilter, setGlobalFilter] = useControllableState<string>(
    globalFilterProp,
    persisted.globalFilter ?? "",
    onGlobalFilterChange,
  );

  // `null` is a meaningful controlled value here ("no advanced filter"), so
  // only `undefined` hands ownership back to the grid.
  const [advancedFilter, setAdvancedFilter] = useControllableState<DataFilterGroup | null>(
    advancedFilterProp,
    persisted.advancedFilter ?? null,
    onAdvancedFilterChange,
  );

  const [columnVisibility, setColumnVisibility] = useControllableState<ColumnVisibilityState>(
    visibilityProp,
    persisted.columnVisibility ?? defaultVisibility(effectiveColumns),
    onColumnVisibilityChange,
  );

  const [columnOrder, setColumnOrder] = useControllableState<ColumnOrderState>(
    orderProp as ColumnOrderState | undefined,
    reconcileOrder(persisted.columnOrder ?? [], allColumnIds),
    onColumnOrderChange,
  );

  const [columnPinning, setColumnPinning] = useControllableState<ColumnPinningState>(
    pinningProp,
    persisted.columnPinning ?? defaultPinning(effectiveColumns),
    onColumnPinningChange,
  );

  const [columnSizing, setColumnSizing] = useControllableState<ColumnSizingState>(
    sizingProp,
    persisted.columnSizing ?? {},
    onColumnSizingChange,
  );

  /**
   * Selection is the one slice a caller commonly controls, so it needs a live
   * escape hatch: the change callback resolves ids back to rows through the
   * table instance. `tableRef` is assigned immediately after `useTable` below,
   * and the callback only ever fires from a user interaction, long after.
   */
  const tableRef = useRef<DataTableInstance<T> | null>(null);
  const controlledSelection = useMemo(
    () => (selectedIds ? idsToSelection(selectedIds) : undefined),
    [selectedIds],
  );
  const notifySelection = useCallback(
    (next: RowSelectionState) => {
      if (!onSelectionChange) return;
      const ids = Object.keys(next).filter((id) => next[id]);
      const byId = tableRef.current?.getCoreRowModel().rowsById ?? {};
      onSelectionChange(
        ids,
        ids.map((id) => byId[id]?.original).filter((row): row is T => row !== undefined),
      );
    },
    [onSelectionChange],
  );
  const [rowSelection, setRowSelection] = useControllableState<RowSelectionState>(
    controlledSelection,
    {},
    notifySelection,
  );

  const [expanded, setExpanded] = useControllableState<ExpandedState>(
    expandedProp,
    // A table that mounts already grouped starts with its lanes open — nobody
    // wants to click open twelve groups to see the data they asked for.
    defaultExpanded ??
      ((persisted.grouping ?? groupingProp ?? []).length > 0 ? true : {}),
    onExpandedChange as ((next: ExpandedState) => void) | undefined,
  );

  const [grouping, setGrouping] = useControllableState<GroupingState>(
    groupingProp as GroupingState | undefined,
    (persisted.grouping ?? EMPTY_ARRAY) as GroupingState,
    onGroupingChange,
  );

  const [pagination, setPagination] = useControllableState<PaginationState>(
    pageIndexProp !== undefined
      ? { pageIndex: pageIndexProp, pageSize: persisted.pageSize ?? pageSizeProp }
      : undefined,
    { pageIndex: 0, pageSize: persisted.pageSize ?? pageSizeProp },
    onPaginationChange,
  );

  /**
   * Grouping a table and then having to open every lane by hand is a hostile
   * default, so switching grouping on expands everything (and switching it off
   * collapses again) — but only while the caller is not driving expansion.
   */
  const expansionUncontrolled = expandedProp === undefined && defaultExpanded === undefined;
  const previousGroupingCount = useRef(grouping.length);
  useEffect(() => {
    const previous = previousGroupingCount.current;
    previousGroupingCount.current = grouping.length;
    if (!expansionUncontrolled) return;
    if (previous === 0 && grouping.length > 0) setExpanded(true);
    else if (previous > 0 && grouping.length === 0) setExpanded({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grouping.length, expansionUncontrolled]);

  // New columns appear (feature flags, tenant config) — fold them into the order.
  useEffect(() => {
    setColumnOrder((previous) => reconcileOrder(previous, allColumnIds));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allColumnIds]);

  /* ---------------------------------------------------------- advanced filter */

  const filterFields = useMemo(() => filterFieldsFromColumns(userColumns), [userColumns]);
  const fieldMap = useMemo(() => filterFieldMap(filterFields), [filterFields]);

  const accessors = useMemo(() => {
    const map = new Map<string, (row: T, index: number) => unknown>();
    for (const column of userColumns) {
      if (column.accessor) map.set(column.id, makeAccessor<T, unknown>(column.accessor, column.id));
    }
    return map;
  }, [userColumns]);

  const prunedAdvanced = useMemo(
    () => (manualFiltering ? null : pruneFilter(advancedFilter, fieldMap)),
    [advancedFilter, fieldMap, manualFiltering],
  );

  const filteredData = useMemo(() => {
    if (!prunedAdvanced) return data;
    return data.filter((row, index) =>
      evaluateFilterNode(
        prunedAdvanced,
        (field) => accessors.get(field)?.(row, index),
        fieldMap,
      ),
    );
  }, [data, prunedAdvanced, accessors, fieldMap]);

  /* ----------------------------------------------------------------- engine */

  const columnDefs = useMemo(
    () =>
      buildColumnDefs<T>(effectiveColumns, {
        sortable,
        resizable: resizableColumns,
        hideable: true,
      }),
    [effectiveColumns, sortable, resizableColumns],
  );

  const resolveRowId = useCallback(
    (row: T, index: number, parent?: { id: string }) =>
      getRowId ? getRowId(row, index) : defaultRowId(row, index, parent?.id),
    [getRowId],
  );

  const rowSelectionEnabled = useMemo(() => {
    if (!selectionMode) return false;
    if (!isRowSelectable) return true;
    return (row: DataRow<T>) => isRowSelectable(row.original);
  }, [selectionMode, isRowSelectable]);

  const paginationState: PaginationState = paginated
    ? pagination
    : { pageIndex: 0, pageSize: Number.POSITIVE_INFINITY };

  const table = useTable<typeof dataTableFeatures, T>({
    features: dataTableFeatures,
    data: filteredData,
    columns: columnDefs,

    state: {
      sorting,
      columnFilters,
      globalFilter,
      columnVisibility,
      columnOrder,
      columnPinning,
      columnSizing,
      rowSelection,
      expanded,
      grouping,
      pagination: paginationState,
    },

    onSortingChange: (updater: Updater<SortingState>) =>
      setSorting((previous) => functionalUpdate(updater, previous)),
    onColumnFiltersChange: (updater: Updater<ColumnFiltersState>) =>
      setColumnFilters((previous) => functionalUpdate(updater, previous)),
    onGlobalFilterChange: (updater: Updater<any>) =>
      setGlobalFilter((previous) => String(functionalUpdate(updater, previous) ?? "")),
    onColumnVisibilityChange: (updater: Updater<ColumnVisibilityState>) =>
      setColumnVisibility((previous) => functionalUpdate(updater, previous)),
    onColumnOrderChange: (updater: Updater<ColumnOrderState>) =>
      setColumnOrder((previous) => functionalUpdate(updater, previous)),
    onColumnPinningChange: (updater: Updater<ColumnPinningState>) =>
      setColumnPinning((previous) => functionalUpdate(updater, previous)),
    onColumnSizingChange: (updater: Updater<ColumnSizingState>) =>
      setColumnSizing((previous) => functionalUpdate(updater, previous)),
    onRowSelectionChange: (updater: Updater<RowSelectionState>) =>
      setRowSelection((previous) => functionalUpdate(updater, previous)),
    onExpandedChange: (updater: Updater<ExpandedState>) =>
      setExpanded((previous) => functionalUpdate(updater, previous)),
    onGroupingChange: (updater: Updater<GroupingState>) =>
      setGrouping((previous) => functionalUpdate(updater, previous)),
    onPaginationChange: (updater: Updater<PaginationState>) =>
      setPagination((previous) => functionalUpdate(updater, previous)),

    getRowId: resolveRowId,
    getSubRows: getSubRows
      ? (row: T) => getSubRows(row) as T[] | undefined
      : undefined,

    globalFilterFn: "dtGlobal",
    enableSorting: sortable,
    enableMultiSort: multiSort,
    enableSortingRemoval: true,
    enableRowSelection: rowSelectionEnabled,
    enableMultiRowSelection: selectionMode === "multi",
    enableSubRowSelection: true,
    enableColumnResizing: resizableColumns,
    columnResizeMode: "onChange",
    enableExpanding: true,
    paginateExpandedRows: false,
    filterFromLeafRows: true,
    manualSorting,
    manualFiltering,
    manualPagination,
    autoResetPageIndex: !manualPagination,
    ...(pageCount !== undefined ? { pageCount } : null),
    ...(totalCount !== undefined ? { rowCount: totalCount } : null),
  });

  tableRef.current = table;

  /* --------------------------------------------------------------- row model */

  const rows = table.getRowModel().rows;
  const headerGroups = table.getHeaderGroups();
  const headers = headerGroups[headerGroups.length - 1]?.headers ?? [];
  const totalWidth = table.getTotalSize();

  const containerWidth = useElementWidth(scrollRef);
  const spacerWidth = Math.max(0, containerWidth - totalWidth);

  /**
   * Header, filter and footer rows must place the flexible spacer at exactly
   * the same point as the body rows — immediately before the first end-pinned
   * column — or the two halves of the grid drift apart when the table is
   * narrower than its viewport.
   */
  const endPinnedHeaderIndex = headers.findIndex(
    (header) => header.column.getIsPinned() === "end",
  );
  const withSpacer = useCallback(
    (render: (header: GridHeader<T>, index: number) => ReactNode): ReactNode[] => {
      const out: ReactNode[] = [];
      headers.forEach((header, index) => {
        if (spacerWidth > 0 && endPinnedHeaderIndex >= 0 && index === endPinnedHeaderIndex) {
          out.push(<div key="__spacer" aria-hidden="true" className="flex-1" />);
        }
        out.push(render(header, index));
      });
      if (spacerWidth > 0 && endPinnedHeaderIndex < 0) {
        out.push(<div key="__spacer" aria-hidden="true" className="flex-1" />);
      }
      return out;
    },
    [headers, spacerWidth, endPinnedHeaderIndex],
  );

  const fallbackRowHeight = resolvedDensity === "compact" ? 34 : 44;
  const measuredRowHeight = useMeasuredRowHeight(probeRef, fallbackRowHeight);
  const rowHeight = rowHeightProp ?? measuredRowHeight;

  const shouldVirtualize = virtualized ?? rows.length > virtualizeThreshold;

  const [headerHeight, setHeaderHeight] = useState(0);
  useEffect(() => {
    const node = headerBlockRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const read = () => setHeaderHeight(Math.round(node.getBoundingClientRect().height));
    read();
    const observer = new ResizeObserver(read);
    observer.observe(node);
    return () => observer.disconnect();
  }, [filterRow, grouping.length]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    getItemKey: (index) => rows[index]?.id ?? index,
    overscan,
    scrollMargin: headerHeight,
    enabled: shouldVirtualize,
  });

  // The virtualizer caches measurements; a density change must invalidate them.
  useEffect(() => {
    if (shouldVirtualize) virtualizer.measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowHeight, shouldVirtualize]);

  const virtualItems = shouldVirtualize ? virtualizer.getVirtualItems() : EMPTY_ARRAY;
  const virtualHeight = shouldVirtualize ? virtualizer.getTotalSize() : rows.length * rowHeight;

  /* -------------------------------------------------------------- scroll state */

  const [scrolledX, setScrolledX] = useState(false);
  const scrollFrame = useRef<number | null>(null);
  const onScroll = useCallback(() => {
    if (scrollFrame.current !== null) return;
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = null;
      const node = scrollRef.current;
      if (!node) return;
      setScrolledX(node.scrollLeft > 0);
    });
  }, []);
  useEffect(
    () => () => {
      if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    },
    [],
  );

  /* -------------------------------------------------------------- editing */

  const rowsById = table.getCoreRowModel().rowsById;
  const getRowById = useCallback(
    (rowId: string) => rowsById[rowId]?.original,
    [rowsById],
  );
  const getColumnById = useCallback((columnId: string) => columnMap.get(columnId), [columnMap]);
  const getCellValue = useCallback(
    (rowId: string, columnId: string) => {
      const row = rowsById[rowId];
      if (!row) return undefined;
      try {
        return row.getValue(columnId);
      } catch {
        return undefined;
      }
    },
    [rowsById],
  );

  const editing = useGridEditing<T>({
    enabled: editable,
    getRow: getRowById,
    getColumn: getColumnById,
    getValue: getCellValue,
    onCellEdit,
    buffer: bufferEdits,
  });

  /* -------------------------------------------------------------- navigation */

  const [focusedCell, setFocusedCell] = useState<{ row: number; col: number } | null>(null);
  const focusedCellRef = useRef(focusedCell);
  focusedCellRef.current = focusedCell;
  const focusRequest = useRef(false);

  /** Put DOM focus back on the focused cell (after an editor unmounts). */
  const refocusCell = useCallback(() => {
    const cell = focusedCellRef.current;
    if (!cell) return;
    requestAnimationFrame(() => {
      scrollRef.current
        ?.querySelector<HTMLElement>(`[data-cell="${cell.row}-${cell.col}"]`)
        ?.focus({ preventScroll: true });
    });
  }, []);

  useEffect(() => {
    if (!focusRequest.current || !focusedCell) return;
    focusRequest.current = false;
    const selector = `[data-cell="${focusedCell.row}-${focusedCell.col}"]`;
    const frame = requestAnimationFrame(() => {
      scrollRef.current?.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusedCell, rows.length]);

  const scrollRowIntoViewRef = useRef<
    (index: number, align?: "start" | "center" | "end" | "auto") => void
  >(() => {});

  const moveFocus = useCallback(
    (rowDelta: number, colDelta: number, absolute?: { row?: number; col?: number }) => {
      const columnCount = headers.length;
      if (rows.length === 0 || columnCount === 0) return;
      setFocusedCell((previous) => {
        const base = previous ?? { row: 0, col: 0 };
        const nextRow = clamp(absolute?.row ?? base.row + rowDelta, 0, rows.length - 1);
        const nextCol = clamp(absolute?.col ?? base.col + colDelta, 0, columnCount - 1);
        scrollRowIntoViewRef.current(nextRow, "auto");
        focusRequest.current = true;
        return { row: nextRow, col: nextCol };
      });
    },
    [headers.length, rows.length],
  );

  const onGridKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!keyboardNavigation) return;
      const session = editing.editing;

      if (session) {
        if (event.key === "Escape") {
          event.preventDefault();
          editing.cancel();
          refocusCell();
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          if (editing.commit()) moveFocus(event.shiftKey ? -1 : 1, 0);
          return;
        }
        if (event.key === "Tab") {
          event.preventDefault();
          if (editing.commit()) moveFocus(0, event.shiftKey ? -1 : 1);
          return;
        }
        return;
      }

      const cell = focusedCell;
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          moveFocus(1, 0);
          return;
        case "ArrowUp":
          event.preventDefault();
          moveFocus(-1, 0);
          return;
        case "ArrowRight":
          event.preventDefault();
          moveFocus(0, 1);
          return;
        case "ArrowLeft":
          event.preventDefault();
          moveFocus(0, -1);
          return;
        case "Home":
          event.preventDefault();
          moveFocus(0, 0, event.ctrlKey || event.metaKey ? { row: 0, col: 0 } : { col: 0 });
          return;
        case "End":
          event.preventDefault();
          moveFocus(
            0,
            0,
            event.ctrlKey || event.metaKey
              ? { row: rows.length - 1, col: headers.length - 1 }
              : { col: headers.length - 1 },
          );
          return;
        case "PageDown":
          event.preventDefault();
          moveFocus(Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 400) / rowHeight)), 0);
          return;
        case "PageUp":
          event.preventDefault();
          moveFocus(-Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 400) / rowHeight)), 0);
          return;
        case "Escape":
          setFocusedCell(null);
          return;
        default:
          break;
      }

      if (!cell) return;
      const row = rows[cell.row];
      const header = headers[cell.col];
      if (!row || !header) return;
      const columnId = header.column.id;

      if (event.key === " " && selectionMode) {
        event.preventDefault();
        row.toggleSelected();
        return;
      }

      if (event.key === "Enter") {
        if (editable && editing.canEdit(row.id, columnId)) {
          event.preventDefault();
          editing.begin(row.id, columnId);
          return;
        }
        if (row.getCanExpand()) {
          event.preventDefault();
          row.toggleExpanded();
          return;
        }
        if (onRowClick) {
          event.preventDefault();
          onRowClick({
            row: row.original,
            rowId: row.id,
            index: cell.row,
            event: event as unknown as React.MouseEvent<HTMLElement>,
          });
          return;
        }
        const link = scrollRef.current?.querySelector<HTMLAnchorElement>(
          `[data-row-id="${escapeAttrValue(row.id)}"] a[data-row-link]`,
        );
        if (link) {
          event.preventDefault();
          link.click();
        }
        return;
      }

      if (
        editable &&
        event.key.length === 1 &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        editing.canEdit(row.id, columnId)
      ) {
        event.preventDefault();
        editing.begin(row.id, columnId, event.key);
      }
    },
    [
      keyboardNavigation,
      editing,
      focusedCell,
      moveFocus,
      refocusCell,
      rows,
      headers,
      rowHeight,
      selectionMode,
      editable,
      onRowClick,
    ],
  );

  /* -------------------------------------------------------------------- api */

  const api = useMemo<DataTableApi<T>>(
    () => ({
      selectedIds: Object.keys(rowSelection).filter((id) => rowSelection[id]),
      toggleRowSelected: (rowId, next) => rowsById[rowId]?.toggleSelected(next),
      toggleRowExpanded: (rowId, next) => rowsById[rowId]?.toggleExpanded(next),
      setGlobalFilter: (value) => setGlobalFilter(value),
      setColumnFilter: (columnId, value) => table.getColumn(columnId)?.setFilterValue(value),
      startEditing: (rowId, columnId) => editing.begin(rowId, columnId),
      density: resolvedDensity,
      rows: rows.map((row) => row.original),
    }),
    [rowSelection, rowsById, setGlobalFilter, table, editing, resolvedDensity, rows],
  );

  /* ----------------------------------------------------------------- footer */

  const showFooterResolved = showFooter ?? stickyFooter;
  const filteredRows = table.getFilteredRowModel().rows;

  const footerValues = useMemo(() => {
    if (!showFooterResolved) return new Map<string, number | null>();
    const map = new Map<string, number | null>();
    for (const column of effectiveColumns) {
      const kind = aggregateFor(column);
      if (kind === "none") continue;
      map.set(
        column.id,
        aggregateValues(
          kind,
          filteredRows.map((row) => {
            try {
              return row.getValue(column.id);
            } catch {
              return undefined;
            }
          }),
        ),
      );
    }
    return map;
  }, [showFooterResolved, effectiveColumns, filteredRows]);

  /* ------------------------------------------------------------ saved views */

  const currentViewState = useMemo<DataViewState>(
    () => ({
      columnVisibility,
      columnOrder,
      columnPinning,
      columnSizing,
      sorting: sorting as DataViewState["sorting"],
      columnFilters: columnFilters as DataViewState["columnFilters"],
      globalFilter,
      grouping: grouping as string[],
      advancedFilter,
      pageSize: pagination.pageSize,
    }),
    [
      columnVisibility,
      columnOrder,
      columnPinning,
      columnSizing,
      sorting,
      columnFilters,
      globalFilter,
      grouping,
      advancedFilter,
      pagination.pageSize,
    ],
  );

  useEffect(() => {
    if (!tableId) return;
    const timer = window.setTimeout(() => saveLayout(tableId, currentViewState), 350);
    return () => window.clearTimeout(timer);
  }, [tableId, currentViewState]);

  const activeView = views.find((view) => view.id === activeViewId);
  const viewDirty = Boolean(activeView) && !viewStatesEqual(activeView?.state, currentViewState);

  const applyView = useCallback(
    (id: string) => {
      const view = views.find((entry) => entry.id === id);
      if (!view) return;
      const state = view.state;
      if (state.columnVisibility) setColumnVisibility(state.columnVisibility);
      if (state.columnOrder) setColumnOrder(reconcileOrder(state.columnOrder, allColumnIds));
      if (state.columnPinning) setColumnPinning(state.columnPinning);
      if (state.columnSizing) setColumnSizing(state.columnSizing);
      setSorting((state.sorting ?? []) as SortingState);
      setColumnFilters((state.columnFilters ?? []) as ColumnFiltersState);
      setGlobalFilter(state.globalFilter ?? "");
      setGrouping((state.grouping ?? []) as GroupingState);
      setAdvancedFilter(state.advancedFilter ?? null);
      setActiveViewId(id);
      saveActiveViewId(tableId, id);
    },
    [
      views,
      allColumnIds,
      setColumnVisibility,
      setColumnOrder,
      setColumnPinning,
      setColumnSizing,
      setSorting,
      setColumnFilters,
      setGlobalFilter,
      setGrouping,
      setAdvancedFilter,
      tableId,
    ],
  );

  const saveView = useCallback(
    (name: string) => {
      const existing = storedViews.find((view) => view.name === name);
      const id = existing?.id ?? makeViewId(name);
      const next = existing
        ? storedViews.map((view) =>
            view.id === id ? { ...view, state: currentViewState } : view,
          )
        : [
            ...storedViews,
            { id, name, state: currentViewState, createdAt: new Date().toISOString() },
          ];
      setStoredViews(next);
      saveViews(tableId, next);
      setActiveViewId(id);
      saveActiveViewId(tableId, id);
    },
    [storedViews, currentViewState, tableId],
  );

  const deleteView = useCallback(
    (id: string) => {
      const next = storedViews.filter((view) => view.id !== id);
      setStoredViews(next);
      saveViews(tableId, next);
      if (activeViewId === id) {
        setActiveViewId(null);
        saveActiveViewId(tableId, null);
      }
    },
    [storedViews, tableId, activeViewId],
  );

  /* --------------------------------------------------------------- CSV export */

  const runExport = useCallback(() => {
    const exportRows = table.getPrePaginatedRowModel().rows.filter((row) => !row.getIsGrouped());
    if (onExport) {
      onExport(exportRows.map((row) => row.original));
      return;
    }
    const exportColumns = table
      .getVisibleLeafColumns()
      .map((column) => columnMap.get(column.id))
      .filter(
        (column): column is DataColumn<T, any> =>
          column !== undefined && column.exportable !== false && !isReserved(column.id),
      );

    exportCsv(
      {
        headers: exportColumns.map(headerTextOf),
        rows: exportRows.map((row) =>
          exportColumns.map((column) => {
            const value = safeGetValue(row, column.id);
            if (column.toCsv) {
              return (
                column.toCsv(
                  makeCellContext(column, value, row, 0, api, false, false, false),
                ) ?? ""
              );
            }
            return csvValueFor(column, value);
          }),
        ),
      },
      `${exportFileName ?? tableId ?? "export"}-${timestampSuffix()}`,
    );
  }, [table, onExport, columnMap, exportFileName, tableId, api]);

  const scrollRowIntoView = useCallback(
    (index: number, align: "start" | "center" | "end" | "auto" = "auto") => {
      if (shouldVirtualize) {
        virtualizer.scrollToIndex(index, { align });
        return;
      }
      const row = rows[index];
      if (!row) return;
      scrollRef.current
        ?.querySelector<HTMLElement>(`[data-row-id="${escapeAttrValue(row.id)}"]`)
        ?.scrollIntoView({ block: align === "auto" ? "nearest" : align });
    },
    [shouldVirtualize, virtualizer, rows],
  );

  scrollRowIntoViewRef.current = scrollRowIntoView;

  /* ------------------------------------------------------------------ handle */

  useImperativeHandle(
    ref,
    () => ({
      scrollToRow: (rowId, align = "auto") => {
        const index = rows.findIndex((row) => row.id === rowId);
        if (index >= 0) scrollRowIntoView(index, align);
      },
      scrollToIndex: (index, align = "auto") => scrollRowIntoView(index, align),
      getRows: () => table.getPrePaginatedRowModel().rows.map((row) => row.original),
      getSelectedRows: () => table.getSelectedRowModel().rows.map((row) => row.original),
      clearSelection: () => table.resetRowSelection(true),
      selectAll: () => table.toggleAllRowsSelected(true),
      exportCsv: () => runExport(),
      resetView: () => {
        setSorting((defaultSort ?? []) as SortingState);
        setColumnFilters([]);
        setGlobalFilter("");
        setAdvancedFilter(null);
        setGrouping([]);
        setColumnSizing({});
        setColumnOrder(allColumnIds);
        setColumnVisibility(defaultVisibility(effectiveColumns));
        setColumnPinning(defaultPinning(effectiveColumns));
        setActiveViewId(null);
        saveActiveViewId(tableId, null);
      },
      discardEdits: () => editing.discard(),
      getDirtyRows: () => editing.dirtyRowIds,
      focus: () => {
        const node = scrollRef.current;
        node?.focus();
        if (!focusedCell) moveFocus(0, 0, { row: 0, col: 0 });
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, table, virtualizer, runExport, editing, allColumnIds, effectiveColumns, focusedCell],
  );

  /* ------------------------------------------------------------ facet options */

  const facetOptions = useCallback(
    (columnId: string) => {
      const column = columnMap.get(columnId);
      if (!column) return EMPTY_ARRAY as never as ReturnType<typeof deriveOptions>;
      const accessor = accessors.get(columnId);
      const source = table.getPreFilteredRowModel().rows;
      const values = accessor
        ? source.map((row) => accessor(row.original, row.index))
        : source.map((row) => safeGetValue(row, columnId));
      return deriveOptions(values, column.filter?.options ?? column.options, column.filter?.maxOptions);
    },
    [columnMap, accessors, table],
  );

  /* ------------------------------------------------------------------ chrome */

  const activeFilterCount =
    columnFilters.length + countLeafConditions(advancedFilter) + (globalFilter ? 1 : 0);

  const hasAnyFilter = activeFilterCount > 0;
  const selectedCount = table.getSelectedRowModel().rows.length;
  const pageRowCount = rows.filter((row) => !row.getIsGrouped()).length;

  const toolbarNode =
    toolbar === false ? null : toolbar !== undefined ? (
      toolbar
    ) : (
      <DataToolbar
        search={searchable ? globalFilter : undefined}
        onSearchChange={searchable ? (value) => setGlobalFilter(value) : undefined}
        searchPlaceholder={searchPlaceholder}
        filterCount={activeFilterCount}
        views={savedViews && tableId ? views : undefined}
        activeViewId={activeViewId}
        onViewChange={savedViews && tableId ? applyView : undefined}
        onSaveView={savedViews && tableId ? saveView : undefined}
        onDeleteView={savedViews && tableId ? deleteView : undefined}
        viewDirty={viewDirty}
        onClearFilters={
          hasAnyFilter
            ? () => {
                setColumnFilters([]);
                setGlobalFilter("");
                setAdvancedFilter(null);
              }
            : undefined
        }
        totalCount={filteredRows.length}
        tools={
          <div className="flex shrink-0 items-center gap-0.5">
            {filterBuilder && filterFields.length > 0 ? (
              <FilterBuilderPopover
                value={advancedFilter}
                fields={filterFields}
                onChange={(next) => setAdvancedFilter(next)}
                optionsFor={facetOptions}
                trigger={
                  <Button
                    variant={countLeafConditions(advancedFilter) > 0 ? "secondary" : "ghost"}
                    size="sm"
                    leadingIcon={IconFilterAdjust}
                    aria-label="Advanced filter"
                  >
                    Filter
                    {countLeafConditions(advancedFilter) > 0 ? (
                      <span className="ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-2xs font-semibold tabular-nums text-accent-fg">
                        {countLeafConditions(advancedFilter)}
                      </span>
                    ) : null}
                  </Button>
                }
              />
            ) : null}

            {columnPicker ? (
              <ColumnPicker
                columns={effectiveColumns}
                visibility={columnVisibility}
                order={columnOrder.length ? columnOrder : allColumnIds}
                pinning={columnPinning}
                onVisibilityChange={setColumnVisibility}
                onOrderChange={setColumnOrder}
                onReset={() => {
                  setColumnVisibility(defaultVisibility(effectiveColumns));
                  setColumnOrder(allColumnIds);
                  setColumnSizing({});
                  setColumnPinning(defaultPinning(effectiveColumns));
                }}
              />
            ) : null}

            {densityToggle ? (
              <Tooltip
                content={resolvedDensity === "compact" ? "Comfortable rows" : "Compact rows"}
              >
                <IconButton
                  icon={IconDensity}
                  label="Toggle row density"
                  size="sm"
                  onClick={() =>
                    setLocalDensity(resolvedDensity === "compact" ? "comfortable" : "compact")
                  }
                />
              </Tooltip>
            ) : null}

            {exportable ? (
              <Tooltip content="Export current view to CSV">
                <IconButton icon={IconDownload} label="Export CSV" size="sm" onClick={runExport} />
              </Tooltip>
            ) : null}

            {toolbarActions}
          </div>
        }
      />
    );

  /* ------------------------------------------------------------------ render */

  const gridRole = getSubRows || grouping.length > 0 ? "treegrid" : "grid";
  const headerRowCount = 1 + (filterRow ? 1 : 0);
  const bodyIsEmpty = !loading && rows.length === 0;

  const viewportStyle: CSSProperties = {
    height,
    maxHeight: maxHeight ?? (shouldVirtualize && height === undefined && !fill ? "70vh" : undefined),
  };

  return (
    <section
      data-density={localDensity ?? undefined}
      style={{ ...densityStyle, ...style }}
      className={cx(
        "relative flex min-w-0 flex-col overflow-hidden bg-surface-raised text-content",
        !flush && "rounded-lg border border-border shadow-e0",
        fill && "min-h-0 flex-1",
        className,
      )}
      aria-busy={loading || undefined}
    >
      {caption ? <h2 className="sr-only">{caption}</h2> : null}

      {/* Density probe — measures the row token straight from CSS. */}
      <div
        ref={probeRef}
        aria-hidden="true"
        className="pointer-events-none absolute left-0 top-0 h-row w-0 opacity-0"
      />

      {toolbarNode}

      {error ? (
        <div className="p-cell-x">
          <ErrorAlert
            title="Could not load this table"
            message={errorMessage(error)}
            onRetry={onRetry}
          />
        </div>
      ) : null}

      <div
        ref={scrollRef}
        onScroll={onScroll}
        onKeyDown={onGridKeyDown}
        tabIndex={-1}
        style={viewportStyle}
        className={cx(
          "relative min-h-0 overflow-auto overscroll-x-contain outline-none",
          fill && "flex-1",
        )}
      >
        <div
          role={gridRole}
          aria-label={props["aria-label"] ?? caption}
          aria-rowcount={(totalCount ?? filteredRows.length) + headerRowCount}
          aria-colcount={headers.length}
          aria-multiselectable={selectionMode === "multi" || undefined}
          style={{ width: Math.max(totalWidth + spacerWidth, 0) || undefined, minWidth: "100%" }}
          className="relative min-w-full"
        >
          {/* ------------------------------------------------------- header */}
          <div
            ref={headerBlockRef}
            role="rowgroup"
            className={cx(
              "sticky top-0 bg-surface-raised",
              Z_CLASS.sticky,
              "shadow-[inset_0_-1px_0_0_var(--ds-border)]",
            )}
          >
            <div role="row" aria-rowindex={1} className={cx(HEADER_ROW_CLASS, "h-row-sm")}>
              {withSpacer((header, index) => (
                <HeaderCell
                  key={header.id}
                  header={header}
                  index={index}
                  column={columnMap.get(header.column.id)}
                  table={table}
                  sortable={sortable}
                  multiSort={multiSort}
                  reorderable={reorderableColumns}
                  resizable={resizableColumns}
                  showMenu={columnMenu}
                  scrolledX={scrolledX}
                  selectionMode={selectionMode}
                  gridLines={gridLines}
                />
              ))}
            </div>

            {filterRow ? (
              <div
                role="row"
                aria-rowindex={2}
                className={cx(HEADER_ROW_CLASS, "h-control-lg border-t border-border-subtle bg-surface-sunken/50")}
              >
                {withSpacer((header) => (
                  <FilterCell
                    key={header.id}
                    header={header}
                    column={columnMap.get(header.column.id)}
                    facetOptions={facetOptions}
                    scrolledX={scrolledX}
                  />
                ))}
              </div>
            ) : null}
          </div>

          {/* --------------------------------------------------------- body */}
          {loading ? (
            <div role="rowgroup" aria-live="polite">
              {Array.from({ length: loadingRows }, (_, index) => (
                <SkeletonRow
                  key={index}
                  index={index}
                  height={rowHeight}
                  widths={headers.map((header) => header.column.getSize())}
                />
              ))}
            </div>
          ) : bodyIsEmpty ? (
            <div role="rowgroup">
              <div role="row" className="sticky left-0 w-full">
                <div
                  role="gridcell"
                  aria-colindex={1}
                  aria-colspan={Math.max(1, headers.length)}
                  className="px-cell-x py-8"
                  style={{ width: containerWidth || undefined }}
                >
                  <EmptyState
                    size="md"
                    bordered={false}
                    icon={(hasAnyFilter ? emptyFiltered?.icon : empty?.icon) ?? IconTableView}
                    title={
                      (hasAnyFilter ? emptyFiltered?.title : empty?.title) ??
                      (hasAnyFilter ? "No matching rows" : "Nothing here yet")
                    }
                    hint={
                      (hasAnyFilter ? emptyFiltered?.description : empty?.description) ??
                      (hasAnyFilter
                        ? "Try relaxing a filter or clearing the search."
                        : undefined)
                    }
                    action={
                      hasAnyFilter ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          leadingIcon={IconRefresh}
                          onClick={() => {
                            setColumnFilters([]);
                            setGlobalFilter("");
                            setAdvancedFilter(null);
                          }}
                        >
                          Clear filters
                        </Button>
                      ) : (
                        (empty?.action ?? undefined)
                      )
                    }
                  />
                </div>
              </div>
            </div>
          ) : (
            <div
              role="rowgroup"
              className="relative w-full"
              style={{ height: shouldVirtualize ? virtualHeight : undefined }}
            >
              {shouldVirtualize
                ? virtualItems.map((item) => {
                    const row = rows[item.index];
                    if (!row) return null;
                    return renderGridRow(row, item.index, {
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      height: item.size,
                      transform: `translateY(${item.start - headerHeight}px)`,
                    });
                  })
                : rows.map((row, index) =>
                    renderGridRow(row, index, { height: rowHeight }),
                  )}
            </div>
          )}

          {/* ------------------------------------------------------- footer */}
          {showFooterResolved && !bodyIsEmpty ? (
            <div
              role="rowgroup"
              className={cx(
                "bg-surface-raised",
                stickyFooter && "sticky bottom-0",
                stickyFooter && Z_CLASS.sticky,
                "shadow-[inset_0_1px_0_0_var(--ds-border)]",
              )}
            >
              <div role="row" className={cx(HEADER_ROW_CLASS, "h-row-sm")}>
                {withSpacer((header, index) => (
                  <FooterCell
                    key={header.id}
                    header={header}
                    column={columnMap.get(header.column.id)}
                    value={footerValues.get(header.column.id) ?? null}
                    rowCount={filteredRows.length}
                    first={index === 0}
                    api={api}
                    scrolledX={scrolledX}
                  />
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {paginated ? (
        <div className="border-t border-border bg-surface-raised">
          <Pagination
            page={pagination.pageIndex}
            pageSize={pagination.pageSize}
            total={totalCount ?? filteredRows.length}
            pageCount={manualPagination ? pageCount : undefined}
            pageSizeOptions={pageSizeOptions}
            onPageChange={(page) => setPagination((previous) => ({ ...previous, pageIndex: page }))}
            onPageSizeChange={(size) => setPagination({ pageIndex: 0, pageSize: size })}
          />
        </div>
      ) : null}

      {editable && editing.changes.length > 0 ? (
        <EditBar
          count={editing.changes.length}
          rows={editing.dirtyRowIds.length}
          onDiscard={() => editing.discard()}
          onCommit={
            onCommitEdits
              ? async () => {
                  await onCommitEdits(editing.changes);
                  editing.accept();
                }
              : undefined
          }
        />
      ) : null}

      {selectionMode && selectedCount > 0 ? (
        <BulkBar
          count={selectedCount}
          pageCount={pageRowCount}
          totalCount={totalCount}
          allAcross={allAcrossSelected}
          onSelectAllAcross={onSelectAllAcross}
          actions={bulkActions ?? EMPTY_ACTIONS}
          rows={table.getSelectedRowModel().rows.map((row) => row.original)}
          ids={table.getSelectedRowModel().rows.map((row) => row.id)}
          onClear={() => table.resetRowSelection(true)}
        />
      ) : null}
    </section>
  );

  /* ---------------------------------------------------------------------- */
  /* Row renderer — kept inside the component so it closes over live state.  */
  /* ---------------------------------------------------------------------- */

  function renderGridRow(row: DataRow<T>, index: number, rowStyle: CSSProperties): ReactNode {
    const original = row.original;
    const isGroupRow = row.getIsGrouped();
    const isSelected = row.getIsSelected();
    const isExpanded = row.getIsExpanded();
    const canExpand = row.getCanExpand();
    const href = !isGroupRow && rowHref ? rowHref(original) : undefined;
    const toneValue = !isGroupRow && rowTone ? rowTone(original) : undefined;
    const dirty = editing.isDirtyRow(row.id);
    const cells = row.getVisibleCells();
    const clickable = Boolean(onRowClick) && !isGroupRow;

    const endPinnedIndex = cells.findIndex((cell) => cell.column.getIsPinned() === "end");
    const treeColumn =
      treeColumnId ??
      effectiveColumns.find((column) => !isReserved(column.id) && column.accessor)?.id;

    const children: ReactNode[] = [];

    cells.forEach((cell, cellIndex) => {
      if (spacerWidth > 0 && endPinnedIndex >= 0 && cellIndex === endPinnedIndex) {
        children.push(<div key="__spacer" aria-hidden="true" className="flex-1" />);
      }

      const columnId = cell.column.id;
      const column = columnMap.get(columnId);
      const pinned = cell.column.getIsPinned();
      const isFocused = focusedCell
        ? focusedCell.row === index && focusedCell.col === cellIndex
        : index === 0 && cellIndex === 0;
      const align = column ? alignFor(column) : "left";
      const cellIsEditing = editing.isEditing(row.id, columnId);
      const cellError = editing.errorFor(row.id, columnId);
      const pending = editing.pendingValue(row.id, columnId);
      const rawValue = pending.has ? pending.value : safeGetValue(row, columnId);

      let content: ReactNode = null;
      let interactive = column?.interactive ?? false;

      if (columnId === SELECT_COLUMN_ID) {
        interactive = true;
        content = isGroupRow ? null : (
          <Checkbox
            size="sm"
            aria-label={`Select row ${index + 1}`}
            checked={isSelected}
            disabled={!row.getCanSelect()}
            onChange={row.getToggleSelectedHandler()}
            onClick={(event) => event.stopPropagation()}
          />
        );
      } else if (columnId === ACTIONS_COLUMN_ID) {
        interactive = true;
        content = isGroupRow ? null : <RowActions row={original} render={rowActions} />;
      } else if (isGroupRow && row.groupingColumnId === columnId) {
        content = (
          <span className="flex min-w-0 items-center gap-1.5">
            <ExpandToggle
              expanded={isExpanded}
              onToggle={() => row.toggleExpanded()}
              label={isExpanded ? "Collapse group" : "Expand group"}
              depth={row.depth}
            />
            <span className="truncate font-semibold text-content">
              {column ? renderCellValue(column, row.groupingValue, { align, density: resolvedDensity }) : toText(row.groupingValue)}
            </span>
            <span className="shrink-0 rounded-full bg-surface-active px-1.5 text-2xs font-medium tabular-nums text-content-muted">
              {row.getLeafRows().length || row.subRows.length}
            </span>
          </span>
        );
      } else if (isGroupRow && !cell.getIsAggregated()) {
        content = null;
      } else if (cellIsEditing) {
        interactive = true;
        content = (
          <CellEditor
            column={column}
            draft={editing.editing?.draft ?? ""}
            error={cellError}
            onDraft={editing.setDraft}
            onCommit={() => editing.commit()}
            onCancel={editing.cancel}
          />
        );
      } else if (column) {
        const context = makeCellContext(
          column,
          rawValue,
          row,
          index,
          api,
          isSelected,
          isExpanded,
          isGroupRow,
        );
        if (isGroupRow && cell.getIsAggregated()) {
          content = column.aggregatedCell
            ? column.aggregatedCell(context)
            : renderCellValue(column, rawValue, { align, density: resolvedDensity });
        } else {
          content = column.cell
            ? column.cell(context)
            : renderCellValue(column, rawValue, { align, density: resolvedDensity });
        }
      }

      const showTreeExpander =
        !isGroupRow && Boolean(getSubRows) && columnId === treeColumn;

      children.push(
        <div
          key={cell.id}
          role="gridcell"
          aria-colindex={cellIndex + 1}
          data-cell={`${index}-${cellIndex}`}
          tabIndex={isFocused ? 0 : -1}
          onFocus={() => setFocusedCell({ row: index, col: cellIndex })}
          onDoubleClick={
            editable && editing.canEdit(row.id, columnId)
              ? (event) => {
                  event.stopPropagation();
                  editing.begin(row.id, columnId);
                }
              : undefined
          }
          style={{
            width: cell.column.getSize(),
            ...(pinned === "start"
              ? { position: "sticky", left: cell.column.getStart("start"), zIndex: 2 }
              : pinned === "end"
                ? { position: "sticky", right: cell.column.getAfter("end"), zIndex: 2 }
                : null),
          }}
          className={cx(
            "group/cell relative flex shrink-0 items-center gap-1.5 overflow-hidden px-cell-x text-body outline-none",
            ALIGN_CLASS[align],
            column?.mono && "font-mono text-code tabular-nums",
            pinned && "bg-inherit",
            pinned === "start" && scrolledX && PINNED_SCROLL_SHADOW,
            pinned === "end" && "border-l border-border",
            gridLines && !pinned && "border-r border-border-subtle",
            cellIsEditing && "z-10 !overflow-visible p-0",
            cellError && "ring-1 ring-inset ring-danger-border",
            editing.isDirtyCell(row.id, columnId) &&
              "bg-warning-subtle/50 shadow-[inset_2px_0_0_0_var(--ds-warning-solid)]",
            "focus-visible:z-10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
            interactive ? "pointer-events-auto" : href ? "pointer-events-none" : undefined,
            column?.cellClassName,
          )}
        >
          {showTreeExpander ? (
            <ExpandToggle
              expanded={isExpanded}
              onToggle={() => row.toggleExpanded()}
              label={isExpanded ? "Collapse row" : "Expand row"}
              depth={row.depth}
              hidden={!canExpand}
            />
          ) : null}
          {content}
          {cellError ? (
            <span
              role="alert"
              className={cx(
                "absolute left-0 top-full z-20 mt-0.5 whitespace-nowrap rounded-sm px-1.5 py-0.5",
                "bg-danger-solid text-2xs text-danger-on-solid shadow-e2",
              )}
            >
              {cellError}
            </span>
          ) : null}
        </div>,
      );
    });

    if (spacerWidth > 0 && endPinnedIndex < 0) {
      children.push(<div key="__spacer" aria-hidden="true" className="flex-1" />);
    }

    return (
      <div
        key={row.id}
        role="row"
        aria-rowindex={index + 1 + headerRowCount}
        aria-selected={selectionMode ? isSelected : undefined}
        aria-level={getSubRows || isGroupRow ? row.depth + 1 : undefined}
        aria-expanded={canExpand ? isExpanded : undefined}
        data-row-id={row.id}
        data-state={isSelected ? "selected" : undefined}
        style={rowStyle}
        onClick={
          clickable
            ? (event) =>
                onRowClick?.({ row: original, rowId: row.id, index, event })
            : undefined
        }
        onDoubleClick={
          onRowDoubleClick && !isGroupRow
            ? (event) => onRowDoubleClick({ row: original, rowId: row.id, index, event })
            : undefined
        }
        className={cx(
          "group/row flex items-stretch border-b border-border-subtle",
          "transition-colors duration-instant",
          isGroupRow
            ? "bg-surface-sunken font-medium"
            : isSelected
              ? "bg-surface-selected"
              : zebra && index % 2 === 1
                ? "bg-surface-sunken/45"
                : "bg-surface-raised",
          !isGroupRow && "hover:bg-surface-hover",
          (clickable || href) && "cursor-pointer",
          dirty && "shadow-[inset_2px_0_0_0_var(--ds-warning-solid)]",
          toneValue && toneStyles[toneValue].bar,
          rowClassName?.(original, index),
        )}
      >
        {href ? (
          <a
            href={href}
            data-row-link=""
            aria-label={rowLabel?.(original) ?? undefined}
            tabIndex={-1}
            onClick={(event) => {
              event.stopPropagation();
              // Modified clicks keep their native meaning: new tab, new window,
              // download, "copy link address". A plain click hands over to the
              // router when the page supplied `onRowClick`.
              if (
                event.defaultPrevented ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey ||
                event.button !== 0
              ) {
                return;
              }
              if (onRowClick) {
                event.preventDefault();
                onRowClick({ row: original, rowId: row.id, index, event });
              }
            }}
            className="absolute inset-0 z-0"
          >
            <span className="sr-only">{rowLabel?.(original) ?? "Open"}</span>
          </a>
        ) : null}
        {children}
      </div>
    );
  }
}

/* ========================================================================== */
/* Header cell                                                                 */
/* ========================================================================== */

function HeaderCell<T extends RowShape>({
  header,
  index,
  column,
  table,
  sortable,
  multiSort,
  reorderable,
  resizable,
  showMenu,
  scrolledX,
  selectionMode,
  gridLines,
}: {
  header: GridHeader<T>;
  index: number;
  column: DataColumn<T, any> | undefined;
  table: DataTableInstance<T>;
  sortable: boolean;
  multiSort: boolean;
  reorderable: boolean;
  resizable: boolean;
  showMenu: boolean;
  scrolledX: boolean;
  selectionMode: false | "single" | "multi";
  gridLines: boolean;
}) {
  const engineColumn = header.column;
  const columnId: string = engineColumn.id;
  const pinned: false | "start" | "end" = engineColumn.getIsPinned();
  const sortDirection: false | "asc" | "desc" = engineColumn.getIsSorted();
  const sortIndex: number = engineColumn.getSortIndex();
  const canSort: boolean = sortable && engineColumn.getCanSort();
  const canResize: boolean = resizable && engineColumn.getCanResize();
  const isResizing: boolean = engineColumn.getIsResizing();
  const align = column ? alignFor(column) : "left";
  const label = column ? headerTextOf(column) : columnId;

  const [dragOver, setDragOver] = useState<false | "before" | "after">(false);

  const isReservedColumn = isReserved(columnId);
  const canReorder = reorderable && !isReservedColumn;

  const selectAllCheckbox =
    columnId === SELECT_COLUMN_ID && selectionMode === "multi" ? (
      <Checkbox
        size="sm"
        aria-label="Select all rows on this page"
        checked={table.getIsAllPageRowsSelected()}
        indeterminate={table.getIsSomePageRowsSelected() && !table.getIsAllPageRowsSelected()}
        onChange={table.getToggleAllPageRowsSelectedHandler()}
      />
    ) : null;

  const content = (
    <>
      {selectAllCheckbox}
      {columnId !== SELECT_COLUMN_ID && columnId !== ACTIONS_COLUMN_ID ? (
        <span className="truncate text-label uppercase text-content-subtle group-hover/header:text-content-muted">
          {typeof column?.header === "string" || column?.header === undefined
            ? label
            : (column.header as ReactNode)}
        </span>
      ) : null}
      {canSort ? <SortGlyph direction={sortDirection} index={sortIndex} active={multiSort} /> : null}
    </>
  );

  return (
    <div
      role="columnheader"
      aria-colindex={index + 1}
      aria-sort={
        sortDirection === "asc" ? "ascending" : sortDirection === "desc" ? "descending" : canSort ? "none" : undefined
      }
      draggable={canReorder}
      onDragStart={
        canReorder
          ? (event) => {
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", columnId);
            }
          : undefined
      }
      onDragOver={
        canReorder
          ? (event) => {
              event.preventDefault();
              const rect = event.currentTarget.getBoundingClientRect();
              setDragOver(event.clientX < rect.left + rect.width / 2 ? "before" : "after");
            }
          : undefined
      }
      onDragLeave={canReorder ? () => setDragOver(false) : undefined}
      onDrop={
        canReorder
          ? (event) => {
              event.preventDefault();
              const source = event.dataTransfer.getData("text/plain");
              const side = dragOver;
              setDragOver(false);
              if (!source || source === columnId) return;
              table.setColumnOrder((previous) =>
                moveColumnId(previous, source, columnId, side === "after"),
              );
            }
          : undefined
      }
      style={{
        width: engineColumn.getSize(),
        ...(pinned === "start"
          ? { position: "sticky", left: engineColumn.getStart("start"), zIndex: 2 }
          : pinned === "end"
            ? { position: "sticky", right: engineColumn.getAfter("end"), zIndex: 2 }
            : null),
      }}
      className={cx(
        "group/header relative flex shrink-0 select-none items-center gap-1 bg-surface-raised px-cell-x",
        ALIGN_CLASS[align],
        pinned === "start" && scrolledX && PINNED_SCROLL_SHADOW,
        pinned === "end" && "border-l border-border",
        gridLines && !pinned && "border-r border-border-subtle",
        isResizing && "bg-accent-subtle/40",
        dragOver === "before" && "shadow-[inset_2px_0_0_0_var(--ds-accent)]",
        dragOver === "after" && "shadow-[inset_-2px_0_0_0_var(--ds-accent)]",
        column?.headerClassName,
      )}
    >
      {canSort ? (
        <button
          type="button"
          onClick={(event) => engineColumn.toggleSorting(undefined, multiSort && event.shiftKey)}
          title={
            multiSort
              ? "Click to sort · Shift-click to add to the sort"
              : "Click to sort"
          }
          className={cx(
            "flex min-w-0 flex-1 items-center gap-1.5 rounded-sm outline-none",
            ALIGN_CLASS[align],
            "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
          )}
        >
          {content}
        </button>
      ) : (
        <span className={cx("flex min-w-0 flex-1 items-center gap-1.5", ALIGN_CLASS[align])}>
          {content}
        </span>
      )}

      {showMenu && !isReservedColumn ? (
        <DropdownMenu
          placement="bottom-end"
          aria-label={`${label} column options`}
          trigger={
            <button
              type="button"
              aria-label={`${label} column options`}
              className={cx(
                "grid size-5 shrink-0 place-items-center rounded-sm text-content-subtle",
                "opacity-0 transition-opacity duration-fast hover:bg-surface-active hover:text-content",
                "group-hover/header:opacity-100 focus-visible:opacity-100",
              )}
            >
              <IconMore size={13} />
            </button>
          }
        >
          <MenuLabel>{label}</MenuLabel>
          {engineColumn.getCanSort() ? (
            <>
              <MenuItem icon={IconArrowUp} onSelect={() => engineColumn.toggleSorting(false)}>
                Sort ascending
              </MenuItem>
              <MenuItem icon={IconArrowDown} onSelect={() => engineColumn.toggleSorting(true)}>
                Sort descending
              </MenuItem>
              {sortDirection ? (
                <MenuItem icon={IconSlash} onSelect={() => engineColumn.clearSorting()}>
                  Clear sort
                </MenuItem>
              ) : null}
              <MenuSeparator />
            </>
          ) : null}
          <MenuItem
            icon={IconPin}
            onSelect={() => engineColumn.pin(pinned === "start" ? false : "start")}
          >
            {pinned === "start" ? "Unpin from start" : "Pin to start"}
          </MenuItem>
          <MenuItem
            icon={IconPin}
            onSelect={() => engineColumn.pin(pinned === "end" ? false : "end")}
          >
            {pinned === "end" ? "Unpin from end" : "Pin to end"}
          </MenuItem>
          {engineColumn.getCanGroup() ? (
            <MenuItem icon={IconGroup} onSelect={() => engineColumn.toggleGrouping()}>
              {engineColumn.getIsGrouped() ? "Remove grouping" : "Group by this column"}
            </MenuItem>
          ) : null}
          {canResize ? (
            <MenuItem icon={IconRuler} onSelect={() => engineColumn.resetSize()}>
              Reset width
            </MenuItem>
          ) : null}
          {engineColumn.getCanHide() ? (
            <>
              <MenuSeparator />
              <MenuItem icon={IconEyeOff} onSelect={() => engineColumn.toggleVisibility(false)}>
                Hide column
              </MenuItem>
            </>
          ) : null}
        </DropdownMenu>
      ) : null}

      {canResize ? (
        <ResizeGrip
          isResizing={isResizing}
          label={`Resize ${label}`}
          onPointerDown={(event) => header.getResizeHandler()(event)}
          onDoubleClick={() => engineColumn.resetSize()}
          onNudge={(delta) => {
            const next = Math.max(48, engineColumn.getSize() + delta);
            table.setColumnSizing((previous) => ({ ...previous, [columnId]: next }));
          }}
        />
      ) : null}
    </div>
  );
}

/* ========================================================================== */
/* Filter row cell                                                             */
/* ========================================================================== */

function FilterCell<T extends RowShape>({
  header,
  column,
  facetOptions,
  scrolledX,
}: {
  header: GridHeader<T>;
  column: DataColumn<T, any> | undefined;
  facetOptions: (columnId: string) => ReturnType<typeof deriveOptions>;
  scrolledX: boolean;
}) {
  const engineColumn = header.column;
  const columnId: string = engineColumn.id;
  const pinned: false | "start" | "end" = engineColumn.getIsPinned();
  const canFilter: boolean = engineColumn.getCanFilter();
  const value = engineColumn.getFilterValue();
  const kind = column ? filterKindFor(column) : "none";
  const label = column ? headerTextOf(column) : columnId;

  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<ReturnType<typeof deriveOptions>>([]);

  useEffect(() => {
    if (open && kind === "enum") setOptions(facetOptions(columnId));
  }, [open, kind, columnId, facetOptions]);

  const selected = Array.isArray(value) ? (value as string[]) : [];

  let control: ReactNode = null;
  if (canFilter && column) {
    if (kind === "enum") {
      control = (
        <Popover
          open={open}
          onOpenChange={setOpen}
          placement="bottom-start"
          padded={false}
          role="listbox"
          aria-label={`${label} filter`}
          trigger={
            <button
              type="button"
              className={cx(
                "flex h-control-xs w-full min-w-0 items-center justify-between gap-1 rounded-sm",
                "border border-border-subtle bg-surface px-1.5 text-meta",
                selected.length ? "text-content" : "text-content-subtle",
                "hover:border-border-strong",
              )}
            >
              <span className="truncate">
                {selected.length === 0
                  ? "All"
                  : selected.length === 1
                    ? selected[0]
                    : `${selected.length} selected`}
              </span>
              {selected.length ? (
                <IconClose
                  size={11}
                  aria-hidden="true"
                  onClick={(event) => {
                    event.stopPropagation();
                    engineColumn.setFilterValue(undefined);
                  }}
                  className="shrink-0 hover:text-danger-fg"
                />
              ) : null}
            </button>
          }
        >
          <OptionCheckList
            options={options}
            selected={selected}
            onToggle={(optionValue, next) => {
              const nextSelected = next
                ? [...selected, optionValue]
                : selected.filter((entry) => entry !== optionValue);
              engineColumn.setFilterValue(nextSelected.length ? nextSelected : undefined);
            }}
            onClear={() => engineColumn.setFilterValue(undefined)}
          />
        </Popover>
      );
    } else if (kind === "number" || kind === "date") {
      control = (
        <RangeFilterControl
          value={value}
          kind={kind}
          step={column.filter?.step}
          label={label}
          onChange={(next) => engineColumn.setFilterValue(next)}
        />
      );
    } else if (kind === "boolean") {
      control = (
        <BooleanFilterControl
          value={value}
          label={label}
          onChange={(next) => engineColumn.setFilterValue(next)}
        />
      );
    } else if (kind !== "none") {
      control = (
        <TextFilterControl
          value={value}
          label={label}
          placeholder={column.filter?.placeholder}
          onChange={(next) => engineColumn.setFilterValue(next)}
        />
      );
    }
  }

  return (
    <div
      role="gridcell"
      style={{
        width: engineColumn.getSize(),
        ...(pinned === "start"
          ? { position: "sticky", left: engineColumn.getStart("start"), zIndex: 2 }
          : pinned === "end"
            ? { position: "sticky", right: engineColumn.getAfter("end"), zIndex: 2 }
            : null),
      }}
      className={cx(
        "flex shrink-0 items-center bg-surface-sunken/50 px-1.5",
        pinned === "start" && scrolledX && PINNED_SCROLL_SHADOW,
        pinned === "end" && "border-l border-border",
      )}
    >
      {control}
    </div>
  );
}

/* ========================================================================== */
/* Footer cell                                                                 */
/* ========================================================================== */

function FooterCell<T extends RowShape>({
  header,
  column,
  value,
  rowCount,
  first,
  api,
  scrolledX,
}: {
  header: GridHeader<T>;
  column: DataColumn<T, any> | undefined;
  value: number | null;
  rowCount: number;
  first: boolean;
  api: DataTableApi<T>;
  scrolledX: boolean;
}) {
  const engineColumn = header.column;
  const pinned: false | "start" | "end" = engineColumn.getIsPinned();
  const align = column ? alignFor(column) : "left";
  const kind = column ? aggregateFor(column) : "none";

  let content: ReactNode = null;
  if (column?.footer !== undefined) {
    content =
      typeof column.footer === "function"
        ? column.footer({
            column: column as DataColumn<T, unknown>,
            columnId: column.id,
            rows: api.rows,
            value,
            formatted: formatAggregate(column, value),
            api,
          })
        : column.footer;
  } else if (kind !== "none" && value !== null) {
    content = <span className="tabular-nums">{formatAggregate(column, value)}</span>;
  } else if (first) {
    content = (
      <span className="text-meta text-content-subtle">
        {formatNumber(rowCount)} {rowCount === 1 ? "row" : "rows"}
      </span>
    );
  }

  return (
    <div
      role="gridcell"
      style={{
        width: engineColumn.getSize(),
        ...(pinned === "start"
          ? { position: "sticky", left: engineColumn.getStart("start"), zIndex: 2 }
          : pinned === "end"
            ? { position: "sticky", right: engineColumn.getAfter("end"), zIndex: 2 }
            : null),
      }}
      className={cx(
        "flex shrink-0 items-center bg-surface-raised px-cell-x text-body font-semibold text-content",
        ALIGN_CLASS[align],
        pinned === "start" && scrolledX && PINNED_SCROLL_SHADOW,
        pinned === "end" && "border-l border-border",
      )}
    >
      {content}
    </div>
  );
}

function formatAggregate<T>(column: DataColumn<T, any> | undefined, value: number | null): string {
  if (value === null || !column) return "";
  const kind = aggregateFor(column);
  if (kind === "count" || kind === "countUnique") return formatNumber(value);
  switch (column.type) {
    case "currency":
      return formatCurrency(value, {
        currency: column.currency,
        precision: column.precision,
        compact: column.compact,
      });
    case "percent":
      return formatPercent(value, { precision: column.precision ?? 1 });
    default:
      return formatNumber(value, { precision: column.precision, compact: column.compact });
  }
}

/* ========================================================================== */
/* Row actions                                                                 */
/* ========================================================================== */

function RowActions<T>({
  row,
  render,
}: {
  row: T;
  render: ((row: T) => ReadonlyArray<DataRowAction<T>> | ReactNode) | undefined;
}) {
  const result = render?.(row);
  if (!result) return null;

  if (Array.isArray(result)) {
    const actions = (result as ReadonlyArray<DataRowAction<T>>).filter((action) => !action.hidden);
    if (actions.length === 0) return null;
    return (
      <DropdownMenu
        placement="bottom-end"
        aria-label="Row actions"
        trigger={
          <button
            type="button"
            aria-label="Row actions"
            onClick={(event) => event.stopPropagation()}
            className={cx(
              "grid size-6 place-items-center rounded-sm text-content-subtle opacity-0",
              "transition-opacity duration-fast hover:bg-surface-active hover:text-content",
              "group-hover/row:opacity-100 focus-visible:opacity-100",
            )}
          >
            <IconMore size={15} />
          </button>
        }
      >
        {actions.map((action) => (
          <MenuItem
            key={action.id}
            icon={action.icon}
            shortcut={action.shortcut}
            destructive={action.destructive}
            disabled={action.disabled}
            onSelect={() => action.onSelect(row)}
          >
            {action.label}
          </MenuItem>
        ))}
      </DropdownMenu>
    );
  }

  return (
    <span
      onClick={(event) => event.stopPropagation()}
      className="flex items-center gap-0.5 opacity-0 transition-opacity duration-fast group-hover/row:opacity-100 focus-within:opacity-100"
    >
      {result as ReactNode}
    </span>
  );
}

/* ========================================================================== */
/* Inline cell editor                                                          */
/* ========================================================================== */

function CellEditor<T>({
  column,
  draft,
  error,
  onDraft,
  onCommit,
  onCancel,
}: {
  column: DataColumn<T, any> | undefined;
  draft: string;
  error: string | null;
  onDraft: (next: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | HTMLSelectElement | null>(null);

  useEffect(() => {
    const node = inputRef.current;
    if (!node) return;
    node.focus();
    if (node instanceof HTMLInputElement) node.select();
  }, []);

  const kind =
    column?.editor?.kind ??
    (column?.type === "number" ||
    column?.type === "currency" ||
    column?.type === "percent" ||
    column?.type === "bytes" ||
    column?.type === "duration"
      ? "number"
      : column?.type === "date" || column?.type === "datetime"
        ? "date"
        : column?.options || column?.type === "enum" || column?.type === "status"
          ? "select"
          : "text");

  const shared = {
    ref: inputRef as never,
    value: draft,
    onBlur: onCommit,
    "aria-invalid": error ? true : undefined,
    "aria-label": column ? headerTextOf(column) : "Edit cell",
    className: cx(
      "h-full w-full min-w-0 border-0 bg-surface px-cell-x text-body text-content outline-none",
      "shadow-[inset_0_0_0_2px_var(--ds-accent)]",
      error && "shadow-[inset_0_0_0_2px_var(--ds-danger-solid)]",
    ),
  };

  if (kind === "select") {
    const options = column?.editor?.options ?? column?.options ?? [];
    return (
      <select
        {...shared}
        onChange={(event) => {
          onDraft(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onCancel();
          }
        }}
      >
        <option value="">—</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.text ?? (typeof option.label === "string" ? option.label : option.value)}
          </option>
        ))}
      </select>
    );
  }

  return (
    <input
      {...shared}
      type={kind === "number" ? "number" : kind === "date" ? "date" : "text"}
      step={column?.editor?.step}
      min={column?.editor?.min}
      max={column?.editor?.max}
      placeholder={column?.editor?.placeholder}
      onChange={(event) => onDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onCancel();
        }
      }}
    />
  );
}

/* ========================================================================== */
/* Column picker                                                               */
/* ========================================================================== */

function ColumnPicker<T>({
  columns,
  visibility,
  order,
  pinning,
  onVisibilityChange,
  onOrderChange,
  onReset,
}: {
  columns: ReadonlyArray<DataColumn<T, any>>;
  visibility: Record<string, boolean>;
  order: readonly string[];
  pinning: { start: string[]; end: string[] };
  onVisibilityChange: (next: Record<string, boolean>) => void;
  onOrderChange: (next: string[]) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ordered = useMemo(() => {
    const map = new Map(columns.map((column) => [column.id, column]));
    const list = order
      .map((id) => map.get(id))
      .filter((column): column is DataColumn<T, any> => column !== undefined);
    for (const column of columns) if (!order.includes(column.id)) list.push(column);
    return list.filter((column) => !isReserved(column.id) && column.hideable !== false);
  }, [columns, order]);

  const hiddenCount = ordered.filter((column) => visibility[column.id] === false).length;

  const move = (id: string, delta: number) => {
    const next = [...order];
    const from = next.indexOf(id);
    if (from < 0) return;
    const to = clamp(from + delta, 0, next.length - 1);
    next.splice(to, 0, ...next.splice(from, 1));
    onOrderChange(next);
  };

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      placement="bottom-end"
      padded={false}
      width={288}
      title="Columns"
      aria-label="Choose columns"
      trigger={
        <Button
          variant={hiddenCount > 0 ? "secondary" : "ghost"}
          size="sm"
          leadingIcon={IconTableView}
          aria-label="Choose columns"
        >
          Columns
          {hiddenCount > 0 ? (
            <span className="ml-1 text-meta tabular-nums text-content-subtle">
              {ordered.length - hiddenCount}/{ordered.length}
            </span>
          ) : null}
        </Button>
      }
    >
      <div className="flex max-h-80 flex-col">
        <ul className="min-h-0 flex-1 overflow-y-auto p-1">
          {ordered.map((column, index) => {
            const visible = visibility[column.id] !== false;
            const pinnedAt = pinning.start.includes(column.id)
              ? "start"
              : pinning.end.includes(column.id)
                ? "end"
                : null;
            return (
              <li
                key={column.id}
                className="group/pick flex items-center gap-2 rounded-sm px-1.5 py-1 hover:bg-surface-hover"
              >
                <Checkbox
                  size="sm"
                  checked={visible}
                  aria-label={`Show ${headerTextOf(column)}`}
                  onChange={(event) =>
                    onVisibilityChange({ ...visibility, [column.id]: event.target.checked })
                  }
                />
                <span className="min-w-0 flex-1 truncate text-body">{headerTextOf(column)}</span>
                {pinnedAt ? (
                  <IconPin size={11} className="shrink-0 text-content-subtle" />
                ) : null}
                <span className="flex shrink-0 items-center opacity-0 group-hover/pick:opacity-100 focus-within:opacity-100">
                  <button
                    type="button"
                    aria-label={`Move ${headerTextOf(column)} up`}
                    disabled={index === 0}
                    onClick={() => move(column.id, -1)}
                    className="grid size-5 place-items-center rounded-xs text-content-subtle hover:bg-surface-active hover:text-content disabled:opacity-30"
                  >
                    <IconArrowUp size={12} />
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${headerTextOf(column)} down`}
                    disabled={index === ordered.length - 1}
                    onClick={() => move(column.id, 1)}
                    className="grid size-5 place-items-center rounded-xs text-content-subtle hover:bg-surface-active hover:text-content disabled:opacity-30"
                  >
                    <IconArrowDown size={12} />
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
        <div className="flex items-center justify-between gap-2 border-t border-border px-2 py-1.5">
          <button
            type="button"
            onClick={() =>
              onVisibilityChange(
                Object.fromEntries(ordered.map((column) => [column.id, true])),
              )
            }
            className="rounded-sm px-1.5 py-0.5 text-meta text-content-muted hover:bg-surface-hover hover:text-content"
          >
            Show all
          </button>
          <button
            type="button"
            onClick={onReset}
            className="rounded-sm px-1.5 py-0.5 text-meta text-content-muted hover:bg-surface-hover hover:text-content"
          >
            Reset layout
          </button>
        </div>
      </div>
    </Popover>
  );
}

/* ========================================================================== */
/* Bulk action bar                                                             */
/* ========================================================================== */

function BulkBar<T>({
  count,
  pageCount,
  totalCount,
  allAcross,
  onSelectAllAcross,
  actions,
  rows,
  ids,
  onClear,
}: {
  count: number;
  pageCount: number;
  totalCount: number | undefined;
  allAcross: boolean;
  onSelectAllAcross: ((selected: boolean) => void) | undefined;
  actions: ReadonlyArray<DataBulkAction<T>>;
  rows: readonly T[];
  ids: readonly string[];
  onClear: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const offerAcross =
    Boolean(onSelectAllAcross) &&
    totalCount !== undefined &&
    totalCount > pageCount &&
    count >= pageCount &&
    pageCount > 0;

  return (
    <div
      role="region"
      aria-label="Bulk actions"
      className={cx(
        "pointer-events-none absolute inset-x-0 bottom-3 flex justify-center px-3",
        Z_CLASS.raised,
      )}
    >
      <div
        className={cx(
          "pointer-events-auto flex max-w-full items-center gap-2 rounded-full border border-border",
          "bg-surface-overlay px-2 py-1.5 shadow-e4",
          "motion-safe:animate-slide-up",
        )}
      >
        <span className="pl-1.5 text-body font-medium tabular-nums text-content">
          {allAcross && totalCount !== undefined ? formatNumber(totalCount) : formatNumber(count)}
        </span>
        <span className="text-body text-content-muted">selected</span>

        {offerAcross ? (
          <button
            type="button"
            onClick={() => onSelectAllAcross?.(!allAcross)}
            className="rounded-full px-2 py-0.5 text-meta text-accent-text underline-offset-2 hover:underline"
          >
            {allAcross ? "Clear" : `Select all ${formatNumber(totalCount ?? 0)}`}
          </button>
        ) : null}

        <span aria-hidden="true" className="mx-0.5 h-5 w-px bg-border" />

        {actions.map((action) => {
          const disabled =
            busy !== null ||
            (typeof action.disabled === "function" ? action.disabled(rows) : action.disabled);
          return (
            <Button
              key={action.id}
              size="sm"
              variant={action.destructive ? "danger" : "ghost"}
              leadingIcon={action.icon}
              disabled={disabled}
              loading={busy === action.id}
              onClick={async () => {
                if (action.confirm && !window.confirm(action.confirm)) return;
                setBusy(action.id);
                try {
                  await action.onSelect(rows, ids);
                } finally {
                  setBusy(null);
                }
              }}
            >
              {action.label}
            </Button>
          );
        })}

        <IconButton icon={IconClose} label="Clear selection" size="sm" onClick={onClear} />
      </div>
    </div>
  );
}

/* ========================================================================== */
/* Pending-edit bar                                                            */
/* ========================================================================== */

function EditBar({
  count,
  rows,
  onDiscard,
  onCommit,
}: {
  count: number;
  rows: number;
  onDiscard: () => void;
  onCommit?: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div
      role="status"
      className={cx(
        "flex items-center justify-between gap-3 border-t border-warning-border bg-warning-subtle px-cell-x py-2",
      )}
    >
      <p className="text-body text-warning-fg">
        <strong className="tabular-nums">{count}</strong> unsaved{" "}
        {count === 1 ? "change" : "changes"} across{" "}
        <strong className="tabular-nums">{rows}</strong> {rows === 1 ? "row" : "rows"}
      </p>
      <div className="flex items-center gap-1.5">
        <Button variant="ghost" size="sm" onClick={onDiscard} disabled={busy}>
          Discard
        </Button>
        {onCommit ? (
          <Button
            size="sm"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onCommit();
              } finally {
                setBusy(false);
              }
            }}
          >
            Save changes
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/* ========================================================================== */
/* Utilities                                                                   */
/* ========================================================================== */

/** Escape a value for a *quoted* attribute selector: only " and \\ matter there. */
function escapeAttrValue(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function isReserved(id: string): boolean {
  return id === SELECT_COLUMN_ID || id === ACTIONS_COLUMN_ID;
}

function idsToSelection(ids: readonly string[]): RowSelectionState {
  const state: RowSelectionState = {};
  for (const id of ids) state[id] = true;
  return state;
}

function reconcileOrder(previous: readonly string[], all: readonly string[]): string[] {
  if (previous.length === 0) return [...all];
  const allSet = new Set(all);
  const kept = previous.filter((id) => allSet.has(id));
  const keptSet = new Set(kept);
  // Nothing added and nothing removed — hand back the same array so the
  // reconciliation effect does not cause a render on every column change.
  if (kept.length === all.length && kept.length === previous.length) {
    return previous as string[];
  }
  if (kept.length === all.length) return kept;
  const result = [...kept];
  all.forEach((id, index) => {
    if (!keptSet.has(id)) result.splice(Math.min(index, result.length), 0, id);
  });
  return result;
}

function moveColumnId(
  order: readonly string[],
  source: string,
  target: string,
  after: boolean,
): string[] {
  const next = order.filter((id) => id !== source);
  const index = next.indexOf(target);
  if (index < 0) return [...order];
  next.splice(after ? index + 1 : index, 0, source);
  return next;
}

function countLeafConditions(node: DataFilterGroup | null): number {
  if (!node) return 0;
  let total = 0;
  for (const child of node.children) {
    total += child.kind === "group" ? countLeafConditions(child) : 1;
  }
  return total;
}

function safeGetValue(row: { getValue: (id: string) => unknown }, columnId: string): unknown {
  try {
    return row.getValue(columnId);
  } catch {
    return undefined;
  }
}

function errorMessage(error: unknown): string {
  if (!error) return "";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  const record = error as { message?: unknown };
  return typeof record.message === "string" ? record.message : "Unexpected error";
}

function makeCellContext<T>(
  column: DataColumn<T, any>,
  value: unknown,
  row: { id: string; depth: number; subRows: unknown[]; original: T; getLeafRows: () => unknown[] },
  index: number,
  api: DataTableApi<T>,
  isSelected: boolean,
  isExpanded: boolean,
  isGrouped: boolean,
): DataCellContext<T, any> {
  return {
    value,
    row: row.original,
    rowId: row.id,
    rowIndex: index,
    column,
    columnId: column.id,
    isSelected,
    isExpanded,
    isGrouped,
    isAggregated: isGrouped,
    isPlaceholder: false,
    depth: row.depth,
    subRowCount: row.subRows.length,
    api,
  };
}
