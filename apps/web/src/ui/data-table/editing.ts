/**
 * data-table/editing — the spreadsheet layer.
 *
 * Owns three things and nothing else:
 *   • which cell is being edited and what the draft text is
 *   • per-cell validation errors
 *   • the buffer of committed-but-unsaved changes (dirty tracking)
 *
 * Navigation lives in the grid; this module only decides whether a value is
 * acceptable and remembers what changed.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { toNumber, toText } from "./format";
import type { DataCellChange, DataColumn, DataColumnType } from "./types";

export interface CellRef {
  rowId: string;
  columnId: string;
}

export interface EditingSession extends CellRef {
  draft: string;
}

export function cellKey(rowId: string, columnId: string): string {
  return `${rowId}::${columnId}`;
}

/** Default string → value conversion, by column type. */
export function parseByType(type: DataColumnType, raw: string): unknown {
  const trimmed = raw.trim();
  switch (type) {
    case "number":
    case "currency":
    case "percent":
    case "duration":
    case "bytes": {
      if (trimmed === "") return null;
      return toNumber(trimmed);
    }
    case "boolean": {
      if (trimmed === "") return null;
      return /^(y|yes|true|1)$/i.test(trimmed);
    }
    default:
      return trimmed === "" ? null : raw;
  }
}

/** Default value → editor string. */
export function serializeByType(type: DataColumnType, value: unknown): string {
  if (value === null || value === undefined) return "";
  switch (type) {
    case "number":
    case "currency":
    case "percent":
    case "duration":
    case "bytes": {
      const numeric = toNumber(value);
      return numeric === null ? "" : String(numeric);
    }
    case "boolean":
      return value ? "true" : "false";
    default:
      return toText(value);
  }
}

const NUMERIC_TYPES: ReadonlySet<DataColumnType> = new Set<DataColumnType>([
  "number",
  "currency",
  "percent",
  "duration",
  "bytes",
]);

export interface UseGridEditingOptions<T> {
  enabled: boolean;
  /** Look a row up by id — the buffer is keyed by id, not by index. */
  getRow: (rowId: string) => T | undefined;
  getColumn: (columnId: string) => DataColumn<T, any> | undefined;
  getValue: (rowId: string, columnId: string) => unknown;
  onCellEdit?: (change: DataCellChange<T>) => void | boolean | Promise<void | boolean>;
  /** Keep committed changes in the grid until the caller flushes them. */
  buffer: boolean;
}

export interface GridEditing<T> {
  editing: EditingSession | null;
  /** True when this exact cell is open for editing. */
  isEditing(rowId: string, columnId: string): boolean;
  /** True when the column and row both allow editing. */
  canEdit(rowId: string, columnId: string): boolean;
  begin(rowId: string, columnId: string, seed?: string): void;
  setDraft(next: string): void;
  /** Validate and store. Returns false when validation rejected the value. */
  commit(raw?: string): boolean;
  cancel(): void;
  errorFor(rowId: string, columnId: string): string | null;
  /** The buffered value for a cell, or `undefined` when it is untouched. */
  pendingValue(rowId: string, columnId: string): { has: boolean; value: unknown };
  isDirtyCell(rowId: string, columnId: string): boolean;
  isDirtyRow(rowId: string): boolean;
  dirtyRowIds: string[];
  changes: Array<DataCellChange<T>>;
  discard(): void;
  discardRow(rowId: string): void;
  /** Drop the buffer after the caller has persisted it. */
  accept(): void;
}

export function useGridEditing<T>(options: UseGridEditingOptions<T>): GridEditing<T> {
  const { enabled, getRow, getColumn, getValue, onCellEdit, buffer } = options;

  const [editing, setEditing] = useState<EditingSession | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Record<string, DataCellChange<T>>>({});

  const optionsRef = useRef(options);
  optionsRef.current = options;

  const canEdit = useCallback(
    (rowId: string, columnId: string) => {
      if (!enabled) return false;
      const column = getColumn(columnId);
      if (!column || !column.editable) return false;
      const row = getRow(rowId);
      if (!row) return false;
      if (typeof column.editable === "function") return column.editable(row);
      return true;
    },
    [enabled, getColumn, getRow],
  );

  const readValue = useCallback(
    (rowId: string, columnId: string): unknown => {
      const key = cellKey(rowId, columnId);
      const buffered = pending[key];
      if (buffered) return buffered.value;
      return getValue(rowId, columnId);
    },
    [pending, getValue],
  );

  const begin = useCallback(
    (rowId: string, columnId: string, seed?: string) => {
      if (!canEdit(rowId, columnId)) return;
      const column = getColumn(columnId);
      const row = getRow(rowId);
      if (!column || !row) return;
      const current = readValue(rowId, columnId);
      const draft =
        seed !== undefined
          ? seed
          : column.serialize
            ? column.serialize(current as never, row)
            : serializeByType(column.type ?? "text", current);
      setEditing({ rowId, columnId, draft });
    },
    [canEdit, getColumn, getRow, readValue],
  );

  const setDraft = useCallback((next: string) => {
    setEditing((previous) => (previous ? { ...previous, draft: next } : previous));
  }, []);

  const cancel = useCallback(() => {
    setEditing((previous) => {
      if (previous) {
        const key = cellKey(previous.rowId, previous.columnId);
        setErrors((current) => {
          if (!(key in current)) return current;
          const next = { ...current };
          delete next[key];
          return next;
        });
      }
      return null;
    });
  }, []);

  const commit = useCallback(
    (raw?: string): boolean => {
      const session = editing;
      if (!session) return false;
      const { rowId, columnId } = session;
      const text = raw ?? session.draft;
      const column = getColumn(columnId);
      const row = getRow(rowId);
      const key = cellKey(rowId, columnId);
      if (!column || !row) {
        setEditing(null);
        return false;
      }

      const type = column.type ?? "text";
      const value = column.parse ? column.parse(text, row) : parseByType(type, text);

      let message: string | null = null;
      if (NUMERIC_TYPES.has(type) && text.trim() !== "" && value === null) {
        message = "Enter a number";
      }
      if (!message && column.validate) {
        message = column.validate(value, row, text) ?? null;
      }

      if (message) {
        setErrors((current) => ({ ...current, [key]: message as string }));
        setEditing({ ...session, draft: text });
        return false;
      }

      setErrors((current) => {
        if (!(key in current)) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });

      const previous = getValue(rowId, columnId);
      const unchanged = Object.is(previous, value) || toText(previous) === toText(value);

      if (!unchanged) {
        const change: DataCellChange<T> = { rowId, columnId, row, previous, value, raw: text };
        if (buffer) {
          setPending((current) => ({ ...current, [key]: change }));
        }
        const result = onCellEdit?.(change);
        if (result === false) {
          setPending((current) => {
            if (!(key in current)) return current;
            const next = { ...current };
            delete next[key];
            return next;
          });
          setErrors((current) => ({ ...current, [key]: "Change rejected" }));
          return false;
        }
      } else if (buffer) {
        // Typed back to the original value — the cell is clean again.
        setPending((current) => {
          if (!(key in current)) return current;
          const next = { ...current };
          delete next[key];
          return next;
        });
      }

      setEditing(null);
      return true;
    },
    [editing, getColumn, getRow, getValue, onCellEdit, buffer],
  );

  const changes = useMemo(() => Object.values(pending), [pending]);

  const dirtyRowIds = useMemo(() => {
    const ids = new Set<string>();
    for (const change of changes) ids.add(change.rowId);
    return [...ids];
  }, [changes]);

  const dirtyRowSet = useMemo(() => new Set(dirtyRowIds), [dirtyRowIds]);

  return {
    editing,
    isEditing: useCallback(
      (rowId: string, columnId: string) =>
        editing !== null && editing.rowId === rowId && editing.columnId === columnId,
      [editing],
    ),
    canEdit,
    begin,
    setDraft,
    commit,
    cancel,
    errorFor: useCallback(
      (rowId: string, columnId: string) => errors[cellKey(rowId, columnId)] ?? null,
      [errors],
    ),
    pendingValue: useCallback(
      (rowId: string, columnId: string) => {
        const entry = pending[cellKey(rowId, columnId)];
        return entry ? { has: true, value: entry.value } : { has: false, value: undefined };
      },
      [pending],
    ),
    isDirtyCell: useCallback(
      (rowId: string, columnId: string) => cellKey(rowId, columnId) in pending,
      [pending],
    ),
    isDirtyRow: useCallback((rowId: string) => dirtyRowSet.has(rowId), [dirtyRowSet]),
    dirtyRowIds,
    changes,
    discard: useCallback(() => {
      setPending({});
      setErrors({});
      setEditing(null);
    }, []),
    discardRow: useCallback((rowId: string) => {
      setPending((current) => {
        const next: Record<string, DataCellChange<T>> = {};
        for (const [key, change] of Object.entries(current)) {
          if (change.rowId !== rowId) next[key] = change;
        }
        return next;
      });
    }, []),
    accept: useCallback(() => {
      setPending({});
      setErrors({});
    }, []),
  };
}
