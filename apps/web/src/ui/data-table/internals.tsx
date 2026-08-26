/**
 * data-table/internals — the small pieces the grid is assembled from.
 *
 * Everything here is deliberately dumb: no table instance, no TanStack types.
 * That keeps the hot render path (cells, filter controls, sort glyphs) cheap
 * to memoise and easy to reason about.
 */
import {
  createElement,
  isValidElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { cx } from "../cx";
import {
  IconArrowDown,
  IconArrowUp,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconChevronsUpDown,
  IconClose,
  IconMinus,
  type IconComponent,
} from "../icons";
import { Avatar, Badge, Checkbox, Input, StatusPill, Tag, type IconLike } from "../primitives";
import { tone as toneStyles, type Density, type Tone } from "../tokens";
import {
  EMPTY_VALUE,
  formatCurrency,
  formatDateCell,
  formatDateTimeCell,
  formatDuration,
  formatFileSize,
  formatNumber,
  formatPercent,
  toDateInputValue,
  toNumber,
  toText,
} from "./format";
import { isEmptyFilterValue, type RangeFilterValue } from "./filters";
import type { DataAlign, DataColumn, DataFilterKind, DataOption } from "./types";

/* ============================================================================
   Tiny helpers
============================================================================ */

/** Render an icon component *or* a plain node at a given pixel size. */
export function renderIconLike(
  icon: IconLike | undefined,
  size = 14,
  className?: string,
): ReactNode {
  if (icon === null || icon === undefined || icon === false) return null;
  // An already-built element passes straight through. Check this BEFORE the
  // component test: an element is also an object carrying $$typeof.
  if (isValidElement(icon)) return icon;
  // A component may be a plain function OR an object — forwardRef and memo
  // both produce `{$$typeof, render}`, which is what every lucide icon is.
  // Testing only for `typeof === "function"` let those fall through to the
  // raw return below, and React refuses to render an object as a child:
  // "Objects are not valid as a React child (found: object with keys
  // {$$typeof, render})". That crashed every Timeline, DataTable, toolbar and
  // description list that was handed an icon component rather than an element.
  if (
    typeof icon === "function" ||
    (typeof icon === "object" && icon !== null && "$$typeof" in (icon as object))
  ) {
    return createElement(icon as IconComponent, { size, className });
  }
  if (typeof icon === "string" || typeof icon === "number") return icon;
  return icon as ReactNode;
}

export const ALIGN_CLASS: Record<DataAlign, string> = {
  left: "justify-start text-left",
  center: "justify-center text-center",
  right: "justify-end text-right",
};

/** `useLayoutEffect` that does not warn during SSR. */
export const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * Controlled-or-not state. When `controlled` is supplied the caller owns the
 * value; otherwise the hook keeps it. `onChange` always fires.
 */
export function useControllableState<T>(
  controlled: T | undefined,
  initial: T,
  onChange?: (next: T) => void,
): [T, (next: T | ((previous: T) => T)) => void] {
  const [internal, setInternal] = useState<T>(initial);
  const isControlled = controlled !== undefined;
  const value = isControlled ? (controlled as T) : internal;

  const valueRef = useRef(value);
  valueRef.current = value;

  const set = useCallback(
    (next: T | ((previous: T) => T)) => {
      const resolved =
        typeof next === "function" ? (next as (previous: T) => T)(valueRef.current) : next;
      if (!isControlled) setInternal(resolved);
      onChange?.(resolved);
    },
    [isControlled, onChange],
  );

  return [value, set];
}

/**
 * Measure the density-driven row height straight from CSS.
 *
 * A zero-width probe carrying `h-row` / `h-row-sm` is measured with a
 * ResizeObserver, so the grid tracks the `data-density` attribute — including a
 * local override on an ancestor — without hard-coding pixel values.
 */
export function useMeasuredRowHeight(
  probeRef: React.RefObject<HTMLElement | null>,
  fallback: number,
): number {
  const [height, setHeight] = useState(fallback);

  useIsomorphicLayoutEffect(() => {
    const node = probeRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const read = () => {
      const next = Math.round(node.getBoundingClientRect().height);
      if (next > 0) setHeight((previous) => (previous === next ? previous : next));
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(node);
    return () => observer.disconnect();
  }, [probeRef]);

  return height;
}

/** Width of the scroll container, tracked for the "stretch to fill" spacer. */
export function useElementWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);

  useIsomorphicLayoutEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const read = () => setWidth(Math.round(node.clientWidth));
    read();
    const observer = new ResizeObserver(read);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);

  return width;
}

/* ============================================================================
   Density
============================================================================ */

/**
 * The density tokens are declared on `:root` in styles.css, so a per-table
 * override has to restate them locally. These two maps mirror section 3 of
 * styles.css exactly — if that file's density scale changes, change these.
 *
 * `data-density` is set alongside them so the `compact:` / `comfortable:`
 * Tailwind variants (which key off the attribute, not the variables) agree.
 */
export const DENSITY_STYLE: Record<Density, CSSProperties> = {
  comfortable: {
    "--ds-control-h": "2.25rem",
    "--ds-control-h-sm": "1.75rem",
    "--ds-control-h-xs": "1.5rem",
    "--ds-control-h-lg": "2.625rem",
    "--ds-control-px": "0.75rem",
    "--ds-control-px-sm": "0.5rem",
    "--ds-control-gap": "0.4375rem",
    "--ds-row-h": "2.75rem",
    "--ds-row-h-sm": "2.25rem",
    "--ds-cell-px": "0.875rem",
    "--ds-cell-py": "0.625rem",
    "--ds-font-body": "0.875rem",
    "--ds-line-body": "1.25rem",
    "--ds-font-meta": "0.75rem",
    "--ds-line-meta": "1rem",
  } as CSSProperties,
  compact: {
    "--ds-control-h": "1.9375rem",
    "--ds-control-h-sm": "1.625rem",
    "--ds-control-h-xs": "1.375rem",
    "--ds-control-h-lg": "2.25rem",
    "--ds-control-px": "0.625rem",
    "--ds-control-px-sm": "0.4375rem",
    "--ds-control-gap": "0.375rem",
    "--ds-row-h": "2.125rem",
    "--ds-row-h-sm": "1.875rem",
    "--ds-cell-px": "0.625rem",
    "--ds-cell-py": "0.3125rem",
    "--ds-font-body": "0.8125rem",
    "--ds-line-body": "1.125rem",
    "--ds-font-meta": "0.6875rem",
    "--ds-line-meta": "0.9375rem",
  } as CSSProperties,
};

function readDensityAttribute(): Density {
  if (typeof document === "undefined") return "comfortable";
  return document.documentElement.getAttribute("data-density") === "compact"
    ? "compact"
    : "comfortable";
}

/**
 * The app-wide density, read straight from `<html data-density>` and kept in
 * sync with a MutationObserver. Deliberately not coupled to the theme context
 * so a grid works in isolation (tests, stories, embedded views).
 */
export function useGlobalDensity(): Density {
  const [density, setDensity] = useState<Density>(readDensityAttribute);

  useEffect(() => {
    if (typeof document === "undefined" || typeof MutationObserver === "undefined") return;
    const root = document.documentElement;
    const sync = () => setDensity(readDensityAttribute());
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ["data-density"] });
    return () => observer.disconnect();
  }, []);

  return density;
}

/* ============================================================================
   Header ornaments
============================================================================ */

export function SortGlyph({
  direction,
  index,
  active,
}: {
  direction: false | "asc" | "desc";
  index: number;
  active: boolean;
}) {
  if (!direction) {
    return (
      <IconChevronsUpDown
        size={12}
        className={cx(
          "shrink-0 text-content-disabled opacity-0 transition-opacity duration-fast",
          "group-hover/header:opacity-100 group-focus-within/header:opacity-100",
        )}
      />
    );
  }
  const Glyph = direction === "asc" ? IconArrowUp : IconArrowDown;
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5 text-accent-text">
      <Glyph size={12} strokeWidth={2.25} />
      {active && index > 0 ? (
        <span className="text-[9px] font-semibold leading-none tabular-nums">{index + 1}</span>
      ) : null}
    </span>
  );
}

/**
 * The 8px hit target on a header's trailing edge.
 *
 * Focusable on purpose: arrow keys nudge the column width (Shift for a bigger
 * step, Enter/Backspace to reset), so column sizing is not a mouse-only
 * feature.
 */
export function ResizeGrip({
  onPointerDown,
  onDoubleClick,
  onNudge,
  isResizing,
  label,
}: {
  onPointerDown: (event: React.MouseEvent | React.TouchEvent) => void;
  onDoubleClick?: () => void;
  onNudge?: (delta: number) => void;
  isResizing: boolean;
  label: string;
}) {
  return (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      tabIndex={onNudge ? 0 : -1}
      onMouseDown={onPointerDown}
      onTouchStart={onPointerDown}
      onDoubleClick={onDoubleClick}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (!onNudge) return;
        const step = event.shiftKey ? 32 : 8;
        if (event.key === "ArrowRight") {
          event.preventDefault();
          onNudge(step);
        } else if (event.key === "ArrowLeft") {
          event.preventDefault();
          onNudge(-step);
        } else if (event.key === "Enter" || event.key === "Backspace") {
          event.preventDefault();
          onDoubleClick?.();
        }
      }}
      className={cx(
        "absolute inset-y-0 -right-1 z-20 flex w-2 cursor-col-resize touch-none select-none items-center justify-center",
        "opacity-0 transition-opacity duration-fast group-hover/header:opacity-100",
        "focus-visible:opacity-100 focus-visible:outline-none",
        isResizing && "opacity-100",
      )}
    >
      <span
        aria-hidden="true"
        className={cx(
          "h-1/2 w-px rounded-full transition-colors duration-fast",
          isResizing ? "h-full w-0.5 bg-accent" : "bg-border-strong",
        )}
      />
    </span>
  );
}

export function ExpandToggle({
  expanded,
  onToggle,
  label,
  depth = 0,
  hidden = false,
}: {
  expanded: boolean;
  onToggle: (event: React.MouseEvent) => void;
  label: string;
  depth?: number;
  hidden?: boolean;
}) {
  if (hidden) {
    return <span aria-hidden="true" className="inline-block size-4 shrink-0" style={depthStyle(depth)} />;
  }
  return (
    <button
      type="button"
      aria-label={label}
      aria-expanded={expanded}
      onClick={(event) => {
        event.stopPropagation();
        onToggle(event);
      }}
      style={depthStyle(depth)}
      className={cx(
        "inline-grid size-4 shrink-0 place-items-center rounded-xs text-content-subtle",
        "transition-colors duration-fast hover:bg-surface-active hover:text-content",
      )}
    >
      {expanded ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
    </button>
  );
}

function depthStyle(depth: number): React.CSSProperties | undefined {
  return depth > 0 ? { marginLeft: depth * 14 } : undefined;
}

/* ============================================================================
   Default cell renderers
============================================================================ */

function optionFor(
  options: readonly DataOption[] | undefined,
  value: unknown,
): DataOption | undefined {
  if (!options) return undefined;
  const key = toText(value);
  return options.find((option) => option.value === key);
}

function deltaTone(value: number): Tone {
  if (value > 0) return "success";
  if (value < 0) return "danger";
  return "neutral";
}

export interface CellValueOptions {
  align: DataAlign;
  density: Density;
}

/**
 * The renderer used when a column does not supply `cell`. This is where the
 * grid earns its living: sensible, dense, right-aligned, tabular defaults for
 * every column type in a construction data model.
 */
export function renderCellValue<T>(
  column: DataColumn<T, any>,
  value: unknown,
  options: CellValueOptions,
): ReactNode {
  const type = column.type ?? "text";
  const empty = column.emptyText ?? EMPTY_VALUE;
  const blank =
    value === null ||
    value === undefined ||
    value === "" ||
    (Array.isArray(value) && value.length === 0);

  if (blank && type !== "boolean") {
    return <span className="text-content-disabled">{empty}</span>;
  }

  switch (type) {
    case "number":
    case "currency":
    case "percent":
    case "duration":
    case "bytes": {
      const numeric = toNumber(value);
      const text =
        type === "currency"
          ? formatCurrency(value, {
              currency: column.currency,
              precision: column.precision,
              compact: column.compact,
              signed: column.signColor,
              placeholder: empty,
            })
          : type === "percent"
            ? formatPercent(value, {
                precision: column.precision ?? 1,
                signed: column.signColor,
                placeholder: empty,
              })
            : type === "duration"
              ? formatDuration(value, empty)
              : type === "bytes"
                ? formatFileSize(value, empty)
                : formatNumber(value, {
                    precision: column.precision,
                    compact: column.compact,
                    signed: column.signColor,
                    placeholder: empty,
                  });

      const tint =
        column.signColor && numeric !== null && numeric !== 0
          ? toneStyles[deltaTone(numeric)].text
          : undefined;

      if (type === "percent" && column.progress) {
        const pct = Math.max(0, Math.min(100, numeric ?? 0));
        return (
          <span className="flex min-w-0 items-center gap-2">
            <span
              className="h-1 min-w-8 flex-1 overflow-hidden rounded-full bg-surface-sunken"
              aria-hidden="true"
            >
              <span
                className={cx(
                  "block h-full rounded-full transition-[width] duration-base ease-standard",
                  pct >= 100 ? "bg-success-solid" : "bg-accent",
                )}
                style={{ width: `${pct}%` }}
              />
            </span>
            <span className="shrink-0 tabular-nums text-content-muted">{text}</span>
          </span>
        );
      }

      return <span className={cx("tabular-nums", tint)}>{text}</span>;
    }

    case "date":
    case "datetime": {
      const text = type === "date" ? formatDateCell(value, empty) : formatDateTimeCell(value, empty);
      return (
        <span className="truncate tabular-nums" title={toText(value)}>
          {text}
        </span>
      );
    }

    case "boolean": {
      const truthy = value === true || value === 1 || value === "true" || value === "yes";
      if (blank) return <IconMinus size={14} className="text-content-disabled" />;
      return truthy ? (
        <IconCheck size={14} strokeWidth={2.25} className="text-success-fg" />
      ) : (
        <IconClose size={14} className="text-content-disabled" />
      );
    }

    case "status": {
      const option = optionFor(column.options, value);
      return (
        <StatusPill
          status={toText(value)}
          label={option?.label ?? option?.text}
          tone={option?.tone}
          size={options.density === "compact" ? "xs" : "sm"}
        />
      );
    }

    case "enum": {
      const option = optionFor(column.options, value);
      if (!option) return <span className="truncate">{toText(value)}</span>;
      return (
        <Badge tone={option.tone ?? "neutral"} size={options.density === "compact" ? "xs" : "sm"} icon={option.icon}>
          {option.label ?? option.text ?? option.value}
        </Badge>
      );
    }

    case "tags": {
      const list = Array.isArray(value) ? value : [value];
      const visible = list.slice(0, 3);
      const overflow = list.length - visible.length;
      return (
        <span className="flex min-w-0 items-center gap-1">
          {visible.map((entry, index) => {
            const option = optionFor(column.options, entry);
            return (
              <Tag key={`${toText(entry)}-${index}`} size="xs" tone={option?.tone ?? "neutral"}>
                {option?.label ?? toText(entry)}
              </Tag>
            );
          })}
          {overflow > 0 ? (
            <span className="shrink-0 text-meta text-content-subtle">+{overflow}</span>
          ) : null}
        </span>
      );
    }

    case "user": {
      const record = (typeof value === "object" && value !== null ? value : null) as Record<
        string,
        unknown
      > | null;
      const name = record ? toText(record["name"] ?? record["fullName"] ?? record) : toText(value);
      const src = record ? (record["avatarUrl"] as string | undefined) : undefined;
      return (
        <span className="flex min-w-0 items-center gap-2">
          <Avatar name={name} src={src ?? null} size="2xs" />
          <span className="truncate">{name}</span>
        </span>
      );
    }

    case "link": {
      const href = toText(value);
      return (
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          onClick={(event) => event.stopPropagation()}
          className="truncate text-accent-text underline-offset-2 hover:underline"
        >
          {href}
        </a>
      );
    }

    case "code":
      return <span className="truncate font-mono text-code">{toText(value)}</span>;

    default:
      return <span className={column.truncate === false ? undefined : "truncate"}>{toText(value)}</span>;
  }
}

/** The plain string a cell contributes to CSV. */
export function csvValueFor<T>(column: DataColumn<T, any>, value: unknown): string {
  const type = column.type ?? "text";
  if (value === null || value === undefined) return "";
  switch (type) {
    case "currency":
    case "number":
    case "percent": {
      const numeric = toNumber(value);
      return numeric === null ? toText(value) : String(numeric);
    }
    case "date":
    case "datetime":
      return toText(value);
    case "boolean":
      return value ? "Yes" : "No";
    case "tags":
      return Array.isArray(value) ? value.map(toText).join("; ") : toText(value);
    default:
      return toText(value);
  }
}

/* ============================================================================
   Filter row controls
============================================================================ */

const FILTER_INPUT = "h-control-xs w-full min-w-0 rounded-sm border-border-subtle bg-surface";

export function TextFilterControl({
  value,
  onChange,
  placeholder,
  label,
}: {
  value: unknown;
  onChange: (next: unknown) => void;
  placeholder?: string;
  label: string;
}) {
  return (
    <Input
      size="xs"
      aria-label={label}
      value={typeof value === "string" ? value : ""}
      placeholder={placeholder ?? "Filter…"}
      onChange={(event) => onChange(event.target.value || undefined)}
      className={FILTER_INPUT}
      inputClassName="text-meta"
    />
  );
}

export function RangeFilterControl({
  value,
  onChange,
  label,
  kind,
  step,
}: {
  value: unknown;
  onChange: (next: unknown) => void;
  label: string;
  kind: "number" | "date";
  step?: number;
}) {
  const range = (value ?? {}) as RangeFilterValue;
  const set = (patch: Partial<RangeFilterValue>) => {
    const next: RangeFilterValue = { ...range, ...patch };
    onChange(isEmptyFilterValue(next) ? undefined : next);
  };
  const inputType = kind === "date" ? "date" : "number";
  const toValue = (raw: RangeFilterValue["min"]) =>
    raw === null || raw === undefined ? "" : kind === "date" ? toDateInputValue(raw) : String(raw);

  return (
    <span className="flex w-full min-w-0 items-center gap-1">
      <Input
        size="xs"
        type={inputType}
        step={step}
        aria-label={`${label} from`}
        placeholder={kind === "number" ? "Min" : undefined}
        value={toValue(range.min)}
        onChange={(event) => set({ min: event.target.value || undefined })}
        className={FILTER_INPUT}
        inputClassName="text-meta"
      />
      <span aria-hidden="true" className="text-content-disabled">
        –
      </span>
      <Input
        size="xs"
        type={inputType}
        step={step}
        aria-label={`${label} to`}
        placeholder={kind === "number" ? "Max" : undefined}
        value={toValue(range.max)}
        onChange={(event) => set({ max: event.target.value || undefined })}
        className={FILTER_INPUT}
        inputClassName="text-meta"
      />
    </span>
  );
}

export function BooleanFilterControl({
  value,
  onChange,
  label,
}: {
  value: unknown;
  onChange: (next: unknown) => void;
  label: string;
}) {
  const current = value === true ? "true" : value === false ? "false" : "";
  return (
    <select
      aria-label={label}
      value={current}
      onChange={(event) => {
        const next = event.target.value;
        onChange(next === "" ? undefined : next === "true");
      }}
      className={cx(
        "h-control-xs w-full min-w-0 rounded-sm border border-border-subtle bg-surface px-1.5 text-meta text-content",
        "focus-ring-inset",
      )}
    >
      <option value="">Any</option>
      <option value="true">Yes</option>
      <option value="false">No</option>
    </select>
  );
}

/** Multi-select popover body — shared by the filter row and the builder. */
export function OptionCheckList({
  options,
  selected,
  onToggle,
  onClear,
  searchable = true,
  emptyText = "No options",
}: {
  options: readonly DataOption[];
  selected: readonly string[];
  onToggle: (value: string, next: boolean) => void;
  onClear?: () => void;
  searchable?: boolean;
  emptyText?: string;
}) {
  const [query, setQuery] = useState("");
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((option) =>
      (option.text ?? (typeof option.label === "string" ? option.label : option.value))
        .toLowerCase()
        .includes(needle),
    );
  }, [options, query]);

  return (
    <div className="flex max-h-72 w-56 flex-col">
      {searchable && options.length > 8 ? (
        <div className="border-b border-border-subtle p-1.5">
          <Input
            size="xs"
            autoFocus
            value={query}
            placeholder="Search…"
            aria-label="Search options"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {filtered.length === 0 ? (
          <p className="px-2 py-3 text-center text-meta text-content-subtle">{emptyText}</p>
        ) : (
          filtered.map((option) => {
            const checked = selectedSet.has(option.value);
            return (
              <label
                key={option.value}
                className={cx(
                  "flex cursor-pointer items-center gap-2 rounded-sm px-1.5 py-1 text-body",
                  "hover:bg-surface-hover",
                )}
              >
                <Checkbox
                  size="sm"
                  checked={checked}
                  onChange={(event) => onToggle(option.value, event.target.checked)}
                />
                <span className="min-w-0 flex-1 truncate">
                  {option.label ?? option.text ?? option.value}
                </span>
                {typeof option.count === "number" ? (
                  <span className="shrink-0 text-meta tabular-nums text-content-subtle">
                    {option.count}
                  </span>
                ) : null}
              </label>
            );
          })
        )}
      </div>
      {onClear && selected.length > 0 ? (
        <div className="border-t border-border-subtle p-1">
          <button
            type="button"
            onClick={onClear}
            className="w-full rounded-sm px-2 py-1 text-left text-meta text-content-muted hover:bg-surface-hover hover:text-content"
          >
            Clear {selected.length} selected
          </button>
        </div>
      ) : null}
    </div>
  );
}

/* ============================================================================
   Loading skeleton
============================================================================ */

export function SkeletonRow({
  widths,
  height,
  index,
}: {
  widths: readonly number[];
  height: number;
  index: number;
}) {
  return (
    <div
      className="flex items-center border-b border-border-subtle"
      style={{ height }}
      aria-hidden="true"
    >
      {widths.map((width, columnIndex) => (
        <div
          key={columnIndex}
          className="shrink-0 px-cell-x"
          style={{ width }}
        >
          <div
            className="skeleton h-2.5 rounded-full"
            style={{
              width: `${skeletonWidth(index, columnIndex)}%`,
              animationDelay: `${(index % 6) * 70}ms`,
            }}
          />
        </div>
      ))}
    </div>
  );
}

function skeletonWidth(row: number, column: number): number {
  // Deterministic pseudo-random so the skeleton does not flicker between renders.
  const seed = (row * 31 + column * 17) % 5;
  return [82, 58, 71, 45, 64][seed] ?? 64;
}

/* ============================================================================
   Misc chrome
============================================================================ */

export function DataCount({ value, noun = "row" }: { value: number; noun?: string }) {
  return (
    <span className="text-meta tabular-nums text-content-subtle">
      {formatNumber(value)} {value === 1 ? noun : `${noun}s`}
    </span>
  );
}

export const FILTER_KIND_LABEL: Record<DataFilterKind, string> = {
  text: "Text",
  number: "Number",
  date: "Date",
  enum: "Options",
  boolean: "Yes / No",
  none: "—",
};
