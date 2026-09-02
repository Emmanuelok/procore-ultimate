/**
 * data-table/filters — value access, the composable filter model, and the
 * predicates behind both the per-column filter row and the advanced builder.
 *
 * No React here: the whole filter language is a pure data structure that can be
 * serialised into a saved view, a URL, or an API query.
 */
import { toDate, toNumber, toText } from "./format";
import type {
  DataAccessor,
  DataColumn,
  DataColumns,
  DataFilterCondition,
  DataFilterField,
  DataFilterGroup,
  DataFilterKind,
  DataFilterNode,
  DataFilterOperator,
  DataOption,
} from "./types";

/* ============================================================================
   Value access
============================================================================ */

/** Safe dotted-path read. `getByPath(row, "vendor.contact.email")`. */
export function getByPath(source: unknown, path: string): unknown {
  if (source === null || source === undefined) return undefined;
  if (!path.includes(".")) return (source as Record<string, unknown>)[path];
  let current: unknown = source;
  for (const segment of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Turn a `DataAccessor` into a plain function. */
export function makeAccessor<T, V>(
  accessor: DataAccessor<T, V> | undefined,
  fallbackKey: string,
): (row: T, index: number) => V {
  if (typeof accessor === "function") return accessor as (row: T, index: number) => V;
  const path = typeof accessor === "string" ? accessor : String(accessor ?? fallbackKey);
  return (row: T) => getByPath(row, path) as V;
}

/* ============================================================================
   Column filter row predicates
   Each returns `true` to KEEP the row.
============================================================================ */

/** `{ min, max }` used by the numeric and date range controls. */
export interface RangeFilterValue {
  min?: number | string | null;
  max?: number | string | null;
}

export function isEmptyFilterValue(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") {
    const range = value as RangeFilterValue;
    if ("min" in range || "max" in range) {
      const hasMin = range.min !== undefined && range.min !== null && range.min !== "";
      const hasMax = range.max !== undefined && range.max !== null && range.max !== "";
      return !hasMin && !hasMax;
    }
    return Object.keys(value as object).length === 0;
  }
  return false;
}

export function textFilter(cellValue: unknown, query: unknown): boolean {
  const needle = toText(query).trim().toLowerCase();
  if (!needle) return true;
  return toText(cellValue).toLowerCase().includes(needle);
}

export function numberRangeFilter(cellValue: unknown, range: unknown): boolean {
  if (isEmptyFilterValue(range)) return true;
  const value = toNumber(cellValue);
  if (value === null) return false;
  const { min, max } = (range ?? {}) as RangeFilterValue;
  const lower = toNumber(min);
  const upper = toNumber(max);
  if (lower !== null && value < lower) return false;
  if (upper !== null && value > upper) return false;
  return true;
}

export function dateRangeFilter(cellValue: unknown, range: unknown): boolean {
  if (isEmptyFilterValue(range)) return true;
  const value = toDate(cellValue);
  if (!value) return false;
  const { min, max } = (range ?? {}) as RangeFilterValue;
  const lower = toDate(min);
  const upper = toDate(max);
  if (lower !== null && value.getTime() < startOfDay(lower)) return false;
  if (upper !== null && value.getTime() > endOfDay(upper)) return false;
  return true;
}

export function enumFilter(cellValue: unknown, selected: unknown): boolean {
  if (!Array.isArray(selected) || selected.length === 0) return true;
  const wanted = new Set(selected.map((entry) => toText(entry)));
  if (Array.isArray(cellValue)) {
    return cellValue.some((entry) => wanted.has(toText(entry)));
  }
  return wanted.has(toText(cellValue));
}

export function booleanFilter(cellValue: unknown, wanted: unknown): boolean {
  if (wanted === null || wanted === undefined || wanted === "") return true;
  const target = wanted === true || wanted === "true";
  const actual =
    cellValue === true ||
    cellValue === "true" ||
    cellValue === 1 ||
    cellValue === "1" ||
    cellValue === "yes";
  return actual === target;
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function endOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999).getTime();
}

/** Dispatch a filter-row value against a cell value for a given control kind. */
export function applyColumnFilter(
  kind: DataFilterKind,
  cellValue: unknown,
  filterValue: unknown,
): boolean {
  switch (kind) {
    case "number":
      return numberRangeFilter(cellValue, filterValue);
    case "date":
      return dateRangeFilter(cellValue, filterValue);
    case "enum":
      return enumFilter(cellValue, filterValue);
    case "boolean":
      return booleanFilter(cellValue, filterValue);
    case "none":
      return true;
    default:
      return textFilter(cellValue, filterValue);
  }
}

/* ============================================================================
   Advanced filter model
============================================================================ */

let sequence = 0;

function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${sequence.toString(36)}`;
}

export interface OperatorSpec {
  value: DataFilterOperator;
  label: string;
  /** How many value inputs the operator needs. */
  arity: 0 | 1 | 2;
  /** Renders a multi-select rather than a single value. */
  multi?: boolean;
}

const TEXT_OPERATORS: OperatorSpec[] = [
  { value: "contains", label: "contains", arity: 1 },
  { value: "notContains", label: "does not contain", arity: 1 },
  { value: "eq", label: "is", arity: 1 },
  { value: "neq", label: "is not", arity: 1 },
  { value: "startsWith", label: "starts with", arity: 1 },
  { value: "endsWith", label: "ends with", arity: 1 },
  { value: "isEmpty", label: "is empty", arity: 0 },
  { value: "isNotEmpty", label: "is not empty", arity: 0 },
];

const NUMBER_OPERATORS: OperatorSpec[] = [
  { value: "eq", label: "=", arity: 1 },
  { value: "neq", label: "≠", arity: 1 },
  { value: "gt", label: ">", arity: 1 },
  { value: "gte", label: "≥", arity: 1 },
  { value: "lt", label: "<", arity: 1 },
  { value: "lte", label: "≤", arity: 1 },
  { value: "between", label: "is between", arity: 2 },
  { value: "isEmpty", label: "is empty", arity: 0 },
  { value: "isNotEmpty", label: "is not empty", arity: 0 },
];

const DATE_OPERATORS: OperatorSpec[] = [
  { value: "eq", label: "is on", arity: 1 },
  { value: "gt", label: "is after", arity: 1 },
  { value: "gte", label: "is on or after", arity: 1 },
  { value: "lt", label: "is before", arity: 1 },
  { value: "lte", label: "is on or before", arity: 1 },
  { value: "between", label: "is between", arity: 2 },
  { value: "isEmpty", label: "is empty", arity: 0 },
  { value: "isNotEmpty", label: "is not empty", arity: 0 },
];

const ENUM_OPERATORS: OperatorSpec[] = [
  { value: "in", label: "is any of", arity: 1, multi: true },
  { value: "notIn", label: "is none of", arity: 1, multi: true },
  { value: "isEmpty", label: "is empty", arity: 0 },
  { value: "isNotEmpty", label: "is not empty", arity: 0 },
];

const BOOLEAN_OPERATORS: OperatorSpec[] = [
  { value: "isTrue", label: "is true", arity: 0 },
  { value: "isFalse", label: "is false", arity: 0 },
  { value: "isEmpty", label: "is empty", arity: 0 },
];

export function operatorsFor(kind: DataFilterKind): OperatorSpec[] {
  switch (kind) {
    case "number":
      return NUMBER_OPERATORS;
    case "date":
      return DATE_OPERATORS;
    case "enum":
      return ENUM_OPERATORS;
    case "boolean":
      return BOOLEAN_OPERATORS;
    case "none":
      return TEXT_OPERATORS;
    default:
      return TEXT_OPERATORS;
  }
}

export function operatorSpec(kind: DataFilterKind, operator: DataFilterOperator): OperatorSpec {
  const list = operatorsFor(kind);
  return list.find((entry) => entry.value === operator) ?? list[0] ?? TEXT_OPERATORS[0]!;
}

export function createCondition(field: string, kind: DataFilterKind): DataFilterCondition {
  const first = operatorsFor(kind)[0];
  return {
    kind: "condition",
    id: nextId("cond"),
    field,
    operator: first?.value ?? "contains",
    value: kind === "enum" ? [] : "",
  };
}

export function createFilterGroup(
  conjunction: "and" | "or" = "and",
  children: DataFilterNode[] = [],
): DataFilterGroup {
  return { kind: "group", id: nextId("grp"), conjunction, children };
}

/** Depth-first replace of a node by id. Returns a new tree. */
export function updateFilterNode(
  group: DataFilterGroup,
  id: string,
  update: (node: DataFilterNode) => DataFilterNode,
): DataFilterGroup {
  if (group.id === id) {
    const next = update(group);
    return next.kind === "group" ? next : group;
  }
  return {
    ...group,
    children: group.children.map((child) => {
      if (child.id === id) return update(child);
      if (child.kind === "group") return updateFilterNode(child, id, update);
      return child;
    }),
  };
}

/** Depth-first remove of a node by id. */
export function removeFilterNode(group: DataFilterGroup, id: string): DataFilterGroup {
  return {
    ...group,
    children: group.children
      .filter((child) => child.id !== id)
      .map((child) => (child.kind === "group" ? removeFilterNode(child, id) : child)),
  };
}

/** Depth-first append into the group with `parentId`. */
export function appendFilterNode(
  group: DataFilterGroup,
  parentId: string,
  node: DataFilterNode,
): DataFilterGroup {
  if (group.id === parentId) {
    return { ...group, children: [...group.children, node] };
  }
  return {
    ...group,
    children: group.children.map((child) =>
      child.kind === "group" ? appendFilterNode(child, parentId, node) : child,
    ),
  };
}

/** How many leaf conditions the tree holds (drives the toolbar badge). */
export function countConditions(node: DataFilterNode | null | undefined): number {
  if (!node) return 0;
  if (node.kind === "condition") return 1;
  return node.children.reduce((total, child) => total + countConditions(child), 0);
}

/** Drop empty groups and unusable conditions. Returns null when nothing is left. */
export function pruneFilter(
  group: DataFilterGroup | null | undefined,
  fields: ReadonlyMap<string, DataFilterField>,
): DataFilterGroup | null {
  if (!group) return null;
  const children: DataFilterNode[] = [];
  for (const child of group.children) {
    if (child.kind === "group") {
      const pruned = pruneFilter(child, fields);
      if (pruned) children.push(pruned);
      continue;
    }
    const field = fields.get(child.field);
    if (!field) continue;
    const spec = operatorSpec(field.kind, child.operator);
    if (spec.arity === 0) {
      children.push(child);
      continue;
    }
    if (isEmptyFilterValue(child.value)) continue;
    if (spec.arity === 2 && isEmptyFilterValue(child.value2)) continue;
    children.push(child);
  }
  if (children.length === 0) return null;
  return { ...group, children };
}

/* ============================================================================
   Evaluation
============================================================================ */

function compareCondition(
  condition: DataFilterCondition,
  kind: DataFilterKind,
  cellValue: unknown,
): boolean {
  const { operator, value, value2 } = condition;

  switch (operator) {
    case "isEmpty":
      return isBlankCell(cellValue);
    case "isNotEmpty":
      return !isBlankCell(cellValue);
    case "isTrue":
      return truthyCell(cellValue);
    case "isFalse":
      return !truthyCell(cellValue) && !isBlankCell(cellValue);
    default:
      break;
  }

  if (kind === "enum") {
    const selected = Array.isArray(value) ? value.map((entry) => toText(entry)) : [toText(value)];
    if (selected.length === 0 || (selected.length === 1 && selected[0] === "")) return true;
    const wanted = new Set(selected);
    const present = Array.isArray(cellValue)
      ? cellValue.some((entry) => wanted.has(toText(entry)))
      : wanted.has(toText(cellValue));
    return operator === "notIn" ? !present : present;
  }

  if (kind === "number") {
    const cell = toNumber(cellValue);
    const a = toNumber(value);
    if (cell === null) return false;
    if (operator === "between") {
      const b = toNumber(value2);
      if (a !== null && cell < a) return false;
      if (b !== null && cell > b) return false;
      return true;
    }
    if (a === null) return true;
    return compareNumbers(operator, cell, a);
  }

  if (kind === "date") {
    const cell = toDate(cellValue);
    const a = toDate(value);
    if (!cell) return false;
    if (operator === "between") {
      const b = toDate(value2);
      if (a && cell.getTime() < startOfDay(a)) return false;
      if (b && cell.getTime() > endOfDay(b)) return false;
      return true;
    }
    if (!a) return true;
    const cellTime = cell.getTime();
    switch (operator) {
      case "eq":
        return cellTime >= startOfDay(a) && cellTime <= endOfDay(a);
      case "neq":
        return cellTime < startOfDay(a) || cellTime > endOfDay(a);
      case "gt":
        return cellTime > endOfDay(a);
      case "gte":
        return cellTime >= startOfDay(a);
      case "lt":
        return cellTime < startOfDay(a);
      case "lte":
        return cellTime <= endOfDay(a);
      default:
        return true;
    }
  }

  const haystack = toText(cellValue).toLowerCase();
  const needle = toText(value).trim().toLowerCase();
  if (!needle) return true;
  switch (operator) {
    case "eq":
      return haystack === needle;
    case "neq":
      return haystack !== needle;
    case "notContains":
      return !haystack.includes(needle);
    case "startsWith":
      return haystack.startsWith(needle);
    case "endsWith":
      return haystack.endsWith(needle);
    case "gt":
      return haystack > needle;
    case "gte":
      return haystack >= needle;
    case "lt":
      return haystack < needle;
    case "lte":
      return haystack <= needle;
    default:
      return haystack.includes(needle);
  }
}

function compareNumbers(operator: DataFilterOperator, cell: number, target: number): boolean {
  switch (operator) {
    case "eq":
      return cell === target;
    case "neq":
      return cell !== target;
    case "gt":
      return cell > target;
    case "gte":
      return cell >= target;
    case "lt":
      return cell < target;
    case "lte":
      return cell <= target;
    default:
      return true;
  }
}

function isBlankCell(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function truthyCell(value: unknown): boolean {
  return value === true || value === 1 || value === "true" || value === "1" || value === "yes";
}

/** Evaluate one node against a row. `read` resolves a field id to a value. */
export function evaluateFilterNode(
  node: DataFilterNode,
  read: (field: string) => unknown,
  fields: ReadonlyMap<string, DataFilterField>,
): boolean {
  if (node.kind === "group") {
    if (node.children.length === 0) return true;
    return node.conjunction === "and"
      ? node.children.every((child) => evaluateFilterNode(child, read, fields))
      : node.children.some((child) => evaluateFilterNode(child, read, fields));
  }
  const field = fields.get(node.field);
  if (!field) return true;
  return compareCondition(node, field.kind, read(node.field));
}

/* ============================================================================
   Deriving fields and options from columns
============================================================================ */

const TYPE_TO_FILTER_KIND: Record<string, DataFilterKind> = {
  text: "text",
  link: "text",
  code: "text",
  user: "text",
  number: "number",
  currency: "number",
  percent: "number",
  duration: "number",
  bytes: "number",
  date: "date",
  datetime: "date",
  boolean: "boolean",
  enum: "enum",
  status: "enum",
  tags: "enum",
  custom: "text",
};

export function filterKindFor<T>(column: DataColumn<T, any>): DataFilterKind {
  if (column.filter?.kind) return column.filter.kind;
  if (!column.accessor) return "none";
  return TYPE_TO_FILTER_KIND[column.type ?? "text"] ?? "text";
}

/** Columns → the field list the advanced builder offers. */
export function filterFieldsFromColumns<T>(columns: DataColumns<T>): DataFilterField[] {
  const fields: DataFilterField[] = [];
  for (const column of columns) {
    if (column.filterable === false) continue;
    if (!column.accessor) continue;
    const kind = filterKindFor(column);
    if (kind === "none") continue;
    fields.push({
      id: column.id,
      label: column.headerText ?? (typeof column.header === "string" ? column.header : column.id),
      kind,
      options: column.filter?.options ?? column.options,
    });
  }
  return fields;
}

export function filterFieldMap(fields: readonly DataFilterField[]): Map<string, DataFilterField> {
  return new Map(fields.map((field) => [field.id, field]));
}

/**
 * Derive enum options from the data when a column did not declare any.
 * Values are counted so the picker can show facet counts.
 */
export function deriveOptions(
  values: readonly unknown[],
  declared: readonly DataOption[] | undefined,
  limit = 200,
): DataOption[] {
  if (declared && declared.length) {
    const counts = new Map<string, number>();
    for (const value of values) {
      for (const entry of Array.isArray(value) ? value : [value]) {
        const key = toText(entry);
        if (!key) continue;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    return declared.map((option) => ({ ...option, count: counts.get(option.value) ?? 0 }));
  }

  const counts = new Map<string, number>();
  for (const value of values) {
    for (const entry of Array.isArray(value) ? value : [value]) {
      const key = toText(entry);
      if (!key) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (counts.size > limit * 4) break;
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}
