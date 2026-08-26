/**
 * data-table/views — saved views and per-table layout persistence.
 *
 * A "view" is the whole grid configuration a user has arranged: which columns
 * are visible, their order, widths and pinning, the sort, the filters and the
 * grouping. Views are stored per `tableId` in localStorage so a project manager
 * who has spent ten minutes arranging a cost report gets it back tomorrow.
 *
 * Every read is defensive: a corrupt or partial payload degrades to "no saved
 * state" rather than throwing inside a render.
 */
import type { DataView, DataViewState } from "./types";

const NAMESPACE = "constructos:table";

export const VIEWS_STORAGE_SUFFIX = "views";
export const LAYOUT_STORAGE_SUFFIX = "layout";
export const ACTIVE_VIEW_SUFFIX = "active";

function storageKey(tableId: string, suffix: string): string {
  return `${NAMESPACE}:${tableId}:${suffix}`;
}

function safeStorage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    const probe = window.localStorage;
    const key = "__constructos_probe__";
    probe.setItem(key, "1");
    probe.removeItem(key);
    return probe;
  } catch {
    return null;
  }
}

function readJson<T>(key: string): T | null {
  const store = safeStorage();
  if (!store) return null;
  try {
    const raw = store.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  const store = safeStorage();
  if (!store) return;
  try {
    if (value === null || value === undefined) store.removeItem(key);
    else store.setItem(key, JSON.stringify(value));
  } catch {
    /* quota or private mode — persistence is a convenience, never a dependency */
  }
}

/* ------------------------------------------------------------------------- */
/* Layout (the "current, unnamed" arrangement)                                */
/* ------------------------------------------------------------------------- */

export function loadLayout(tableId: string | undefined): DataViewState | null {
  if (!tableId) return null;
  const value = readJson<DataViewState>(storageKey(tableId, LAYOUT_STORAGE_SUFFIX));
  return isViewState(value) ? value : null;
}

export function saveLayout(tableId: string | undefined, state: DataViewState): void {
  if (!tableId) return;
  writeJson(storageKey(tableId, LAYOUT_STORAGE_SUFFIX), state);
}

export function clearLayout(tableId: string | undefined): void {
  if (!tableId) return;
  writeJson(storageKey(tableId, LAYOUT_STORAGE_SUFFIX), null);
}

/* ------------------------------------------------------------------------- */
/* Named views                                                                */
/* ------------------------------------------------------------------------- */

export function loadViews(tableId: string | undefined): DataView[] {
  if (!tableId) return [];
  const value = readJson<unknown>(storageKey(tableId, VIEWS_STORAGE_SUFFIX));
  if (!Array.isArray(value)) return [];
  const views: DataView[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as Partial<DataView>;
    if (typeof candidate.id !== "string" || typeof candidate.name !== "string") continue;
    if (!isViewState(candidate.state)) continue;
    views.push({
      id: candidate.id,
      name: candidate.name,
      state: candidate.state,
      createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : undefined,
    });
  }
  return views;
}

export function saveViews(tableId: string | undefined, views: readonly DataView[]): void {
  if (!tableId) return;
  writeJson(
    storageKey(tableId, VIEWS_STORAGE_SUFFIX),
    views.filter((view) => !view.builtIn),
  );
}

export function loadActiveViewId(tableId: string | undefined): string | null {
  if (!tableId) return null;
  const value = readJson<string>(storageKey(tableId, ACTIVE_VIEW_SUFFIX));
  return typeof value === "string" ? value : null;
}

export function saveActiveViewId(tableId: string | undefined, id: string | null): void {
  if (!tableId) return;
  writeJson(storageKey(tableId, ACTIVE_VIEW_SUFFIX), id);
}

export function makeViewId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${slug || "view"}-${Math.random().toString(36).slice(2, 7)}`;
}

/* ------------------------------------------------------------------------- */
/* Comparison                                                                 */
/* ------------------------------------------------------------------------- */

/** Structural equality good enough to decide whether a view is "dirty". */
export function viewStatesEqual(
  a: DataViewState | null | undefined,
  b: DataViewState | null | undefined,
): boolean {
  return stableStringify(normaliseViewState(a)) === stableStringify(normaliseViewState(b));
}

function normaliseViewState(state: DataViewState | null | undefined): DataViewState {
  if (!state) return {};
  const next: DataViewState = {};
  if (state.columnVisibility && Object.keys(state.columnVisibility).length)
    next.columnVisibility = state.columnVisibility;
  if (state.columnOrder && state.columnOrder.length) next.columnOrder = state.columnOrder;
  if (state.columnPinning && (state.columnPinning.start.length || state.columnPinning.end.length))
    next.columnPinning = state.columnPinning;
  if (state.columnSizing && Object.keys(state.columnSizing).length)
    next.columnSizing = state.columnSizing;
  if (state.sorting && state.sorting.length) next.sorting = state.sorting;
  if (state.columnFilters && state.columnFilters.length) next.columnFilters = state.columnFilters;
  if (state.globalFilter) next.globalFilter = state.globalFilter;
  if (state.grouping && state.grouping.length) next.grouping = state.grouping;
  if (state.advancedFilter) next.advancedFilter = state.advancedFilter;
  if (state.pageSize) next.pageSize = state.pageSize;
  return next;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function isViewState(value: unknown): value is DataViewState {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
