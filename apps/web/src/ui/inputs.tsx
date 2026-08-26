/**
 * inputs.tsx — the advanced data-entry layer of the ConstructOS design system.
 *
 * Everything a dense operational product needs to make typing fast:
 * comboboxes with async search, multi-select with chips, people/vendor
 * pickers, the whole date/time family, lossless money and number entry,
 * tag entry, file intake, signature capture, a lightweight rich-text field,
 * plus the form scaffolding and state hook that hold a page together.
 *
 * House rules, identical to ./primitives and ./overlays:
 *
 *   1. Keyboard first.     Every control is fully operable without a mouse and
 *                          publishes the ARIA pattern it actually implements.
 *   2. Token only.         No hex, no bespoke shadows, no invented z-indexes.
 *   3. Both themes.        Colour comes from semantic tokens, so dark is free.
 *   4. Motion is optional. Panels animate through ./motion, which collapses
 *                          under `prefers-reduced-motion`.
 *   5. Never lossy.        Money is stored in minor units and parsed with
 *                          integer arithmetic; nothing round-trips through a
 *                          float on the way to the server.
 *   6. No endpoints.       Anything async takes a fetcher prop. This module
 *                          knows nothing about the API surface.
 *
 * Positioning is @floating-ui/react. Escape ordering is shared with
 * ./overlays through `useOverlayEscape`, so a combobox inside a drawer inside
 * a dialog unwinds one layer per key press.
 */
import {
  forwardRef,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ChangeEvent,
  ClipboardEvent as ReactClipboardEvent,
  DragEvent as ReactDragEvent,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import {
  FloatingFocusManager,
  FloatingPortal,
  autoUpdate,
  flip,
  offset,
  shift,
  size as floatingSize,
  useDismiss,
  useFloating,
  useInteractions,
} from "@floating-ui/react";
import type { Placement } from "@floating-ui/react";
import { DayFlag, DayPicker, SelectionState, UI } from "react-day-picker";
import type { DayPickerProps, Matcher } from "react-day-picker";
import {
  addDays,
  addMonths,
  differenceInCalendarDays,
  endOfMonth,
  endOfQuarter,
  endOfWeek,
  format as formatDate,
  isValid as isValidDate,
  parse as parseDateFns,
  startOfDay,
  startOfMonth,
  startOfQuarter,
  startOfWeek,
  startOfYear,
  subDays,
  subMonths,
} from "date-fns";

import { cx } from "./cx";
import { Z_CLASS, readToken, tone as toneStyles } from "./tokens";
import type { Tone } from "./tokens";
import { AnimatePresence, motion, scaleIn, useVariants } from "./motion";
import {
  Avatar,
  Button,
  Checkbox,
  Kbd,
  Tag,
  VisuallyHidden,
  initialsFrom,
} from "./primitives";
import type { ControlSize, IconLike } from "./primitives";
import { OVERLAY_PORTAL_ID, useOverlayEscape } from "./overlays";
import {
  IconAlert,
  IconArrowDown,
  IconArrowUp,
  IconAttachment,
  IconCalendar,
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconClock,
  IconClose,
  IconDocument,
  IconFile,
  IconLink,
  IconListView,
  IconPhoto,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconSignature,
  IconSpinner,
  IconTrash,
  IconUndo,
  IconUpload,
  IconUser,
  IconVendor,
  IconWarning,
} from "./icons";
import type { IconComponent } from "./icons";
import { useResolvedTheme } from "../lib/theme";

/* ==========================================================================
   Shared vocabulary
   ========================================================================== */

/** Control height, mirroring `ControlSize` in ./primitives. */
export type InputSize = ControlSize;

const SIZE_H: Record<InputSize, string> = {
  xs: "h-control-xs",
  sm: "h-control-sm",
  md: "h-control",
  lg: "h-control-lg",
};

const SIZE_MIN_H: Record<InputSize, string> = {
  xs: "min-h-control-xs",
  sm: "min-h-control-sm",
  md: "min-h-control",
  lg: "min-h-control-lg",
};

const SIZE_TEXT: Record<InputSize, string> = {
  xs: "text-2xs",
  sm: "text-xs",
  md: "text-body",
  lg: "text-sm",
};

const SIZE_RADIUS: Record<InputSize, string> = {
  xs: "rounded-sm",
  sm: "rounded-md",
  md: "rounded-md",
  lg: "rounded-lg",
};

const SIZE_PX: Record<InputSize, string> = {
  xs: "px-1.5",
  sm: "px-2",
  md: "px-2.5",
  lg: "px-3",
};

const SIZE_ICON: Record<InputSize, number> = { xs: 12, sm: 14, md: 16, lg: 18 };

/**
 * The bordered box every text-entry control in the system shares. Kept
 * byte-identical in behaviour to `fieldShell` in ./primitives so an Input and
 * a Combobox sitting side by side are indistinguishable until you use them.
 */
function shellClass(size: InputSize, invalid?: boolean, disabled?: boolean): string {
  return cx(
    "relative flex w-full items-center bg-surface-raised text-content shadow-e0",
    "border transition-[color,background-color,border-color,box-shadow]",
    SIZE_RADIUS[size],
    SIZE_TEXT[size],
    invalid
      ? "border-danger-border focus-within:border-danger-solid focus-within:ring-3 focus-within:ring-danger-solid/25"
      : cx(
          "border-border focus-within:border-accent focus-within:ring-3 focus-within:ring-accent/25",
          "[&:hover:not(:focus-within)]:border-border-strong",
        ),
    disabled && "cursor-not-allowed opacity-60",
  );
}

/** The bare control that sits inside `shellClass`. */
const BARE_INPUT =
  "peer h-full w-full min-w-0 bg-transparent text-inherit outline-none " +
  "placeholder:text-content-subtle disabled:cursor-not-allowed";

/** Floating surface recipe, matched to ./overlays' FLOATING_PANEL. */
const PANEL =
  "rounded-lg border border-border bg-surface-overlay shadow-e3 " +
  "supports-[backdrop-filter]:bg-surface-overlay/95 supports-[backdrop-filter]:backdrop-blur-xl";

/** A row in any of this module's listboxes. */
const OPTION_ROW =
  "group/opt relative flex w-full cursor-pointer select-none items-center gap-2 " +
  "rounded-md px-2 py-1.5 text-body text-content outline-none transition-colors " +
  "data-[active=true]:bg-surface-hover data-[disabled=true]:cursor-not-allowed " +
  "data-[disabled=true]:opacity-45";

function isComponentLike(value: unknown): value is IconComponent {
  if (typeof value === "function") return true;
  return typeof value === "object" && value !== null && "$$typeof" in (value as object);
}

/** Render an `IconLike` at a given pixel size. Elements pass through untouched. */
function renderIcon(icon: IconLike, px: number, className?: string): ReactNode {
  if (icon === null || icon === undefined || icon === false) return null;
  if (isValidElement(icon)) return icon;
  if (isComponentLike(icon)) {
    const Cmp = icon as IconComponent;
    return <Cmp size={px} className={className} />;
  }
  return icon as ReactNode;
}

function useControllableState<T>(
  controlled: T | undefined,
  fallback: T,
  onChange?: (value: T) => void,
): readonly [T, (value: T) => void] {
  const [uncontrolled, setUncontrolled] = useState<T>(fallback);
  const isControlled = controlled !== undefined;
  const value = isControlled ? (controlled as T) : uncontrolled;
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const setValue = useCallback(
    (next: T) => {
      if (!isControlled) setUncontrolled(next);
      changeRef.current?.(next);
    },
    [isControlled],
  );
  return [value, setValue] as const;
}

/** Latest-callback ref: keeps effects stable when a caller passes an inline fn. */
function useEvent<A extends unknown[], R>(
  callback: ((...args: A) => R) | undefined,
): (...args: A) => R | undefined {
  const ref = useRef(callback);
  ref.current = callback;
  return useCallback((...args: A) => ref.current?.(...args), []);
}

/** Debounce any value. Used by SearchInput and every async list in this file. */
export function useDebouncedValue<T>(value: T, delay = 220): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    if (delay <= 0) {
      setDebounced(value);
      return;
    }
    const id = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

function useIsomorphicId(provided: string | undefined): string {
  const generated = useId();
  return provided ?? generated;
}

/* ------------------------------------------------------------------ matching */

function normalise(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/**
 * Split `text` on every occurrence of `query` and bold the matches. Returns the
 * plain string when there is nothing to mark, so the common case allocates
 * nothing.
 */
function highlightMatch(text: string, query: string): ReactNode {
  const q = query.trim();
  if (!q) return text;
  const haystack = normalise(text);
  const needle = normalise(q);
  if (!needle || !haystack.includes(needle)) return text;

  const parts: ReactNode[] = [];
  let cursor = 0;
  let found = haystack.indexOf(needle, cursor);
  let key = 0;
  while (found !== -1) {
    if (found > cursor) parts.push(text.slice(cursor, found));
    parts.push(
      <mark key={`m${key}`} className="bg-transparent font-semibold text-content">
        {text.slice(found, found + needle.length)}
      </mark>,
    );
    key += 1;
    cursor = found + needle.length;
    found = haystack.indexOf(needle, cursor);
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

/* ==========================================================================
   Async option loading
   ========================================================================== */

/**
 * Fetch options for a query, debounced, abortable and race-safe.
 *
 * The loader is held in a ref, so passing an inline arrow does NOT cause an
 * infinite refetch loop. That means a *genuinely* new loader will not refetch
 * on its own — call `reload()` (or change `query`) when the closure's inputs
 * change.
 */
function useAsyncOptions<T>(
  loader: ((query: string, signal: AbortSignal) => Promise<readonly T[]>) | undefined,
  query: string,
  active: boolean,
  debounceMs: number,
): {
  options: readonly T[];
  loading: boolean;
  error: Error | null;
  reload: () => void;
} {
  const [options, setOptions] = useState<readonly T[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);
  const load = useEvent(loader);
  const hasLoader = Boolean(loader);
  const debouncedQuery = useDebouncedValue(query, debounceMs);

  useEffect(() => {
    if (!hasLoader || !active) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const result = await load(debouncedQuery, controller.signal);
        if (cancelled || controller.signal.aborted) return;
        setOptions(result ?? []);
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;
        if ((err as { name?: string })?.name === "AbortError") return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setOptions([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [hasLoader, active, debouncedQuery, nonce, load]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { options, loading, error, reload };
}

/* ==========================================================================
   AnchoredPanel — the floating surface every control in this file opens
   --------------------------------------------------------------------------
   ./overlays owns `Popover`, but Popover clones its trigger and drives it with
   `useClick`. A combobox needs the *input* to keep focus and to own
   aria-expanded / aria-activedescendant itself, and a date field needs its
   trigger to toggle rather than reopen on outside-press. So this module keeps
   one small anchored surface of its own, and shares ./overlays' Escape stack
   and portal so layer ordering stays global.
   ========================================================================== */

interface AnchoredPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The element the panel is positioned against and treated as "inside". */
  anchor: HTMLElement | null;
  children: ReactNode;
  placement?: Placement;
  /** Match the anchor's width exactly (comboboxes). */
  matchAnchorWidth?: boolean;
  /** Never narrower than the anchor (date panels, which may be wider). */
  minAnchorWidth?: boolean;
  maxHeight?: number;
  /** Trap Tab inside the panel — used by the calendar/dialog-shaped panels. */
  trapFocus?: boolean;
  className?: string;
  id?: string;
  role?: "listbox" | "dialog" | "grid" | "tree";
  ariaLabel?: string;
  ariaLabelledBy?: string;
  width?: number | string;
}

function AnchoredPanel({
  open,
  onOpenChange,
  anchor,
  children,
  placement = "bottom-start",
  matchAnchorWidth = false,
  minAnchorWidth = false,
  maxHeight,
  trapFocus = false,
  className,
  id,
  role = "listbox",
  ariaLabel,
  ariaLabelledBy,
  width,
}: AnchoredPanelProps) {
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange,
    placement,
    middleware: [
      offset(6),
      flip({ padding: 10 }),
      shift({ padding: 10 }),
      floatingSize({
        padding: 10,
        apply({ availableHeight, rects, elements }) {
          const style = elements.floating.style;
          style.setProperty(
            "--ds-avail-h",
            `${Math.max(160, Math.floor(availableHeight))}px`,
          );
          if (matchAnchorWidth) style.width = `${rects.reference.width}px`;
          if (minAnchorWidth) style.minWidth = `${rects.reference.width}px`;
        },
      }),
    ],
    whileElementsMounted: autoUpdate,
  });

  useEffect(() => {
    refs.setReference(anchor);
  }, [anchor, refs]);

  const dismiss = useDismiss(context, {
    escapeKey: false,
    outsidePress: true,
    outsidePressEvent: "mousedown",
  });
  const { getFloatingProps } = useInteractions([dismiss]);
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  useOverlayEscape(open, close);
  const panelVariants = useVariants(scaleIn);

  const panel = (
    <div
      ref={refs.setFloating}
      style={{ ...floatingStyles, width }}
      {...getFloatingProps()}
      className={cx(Z_CLASS.popover, "outline-none")}
    >
      <motion.div
        variants={panelVariants}
        initial="hidden"
        animate="visible"
        exit="exit"
        id={id}
        role={role}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        style={{ maxHeight: maxHeight ?? "var(--ds-avail-h, 22rem)" }}
        className={cx(PANEL, "flex min-w-[13rem] flex-col overflow-hidden", className)}
      >
        {children}
      </motion.div>
    </div>
  );

  return (
    <AnimatePresence>
      {open ? (
        <FloatingPortal key="anchored-panel" id={OVERLAY_PORTAL_ID}>
          {trapFocus ? (
            <FloatingFocusManager context={context} modal={false} returnFocus>
              {panel}
            </FloatingFocusManager>
          ) : (
            panel
          )}
        </FloatingPortal>
      ) : null}
    </AnimatePresence>
  );
}

/* ==========================================================================
   Small shared pieces
   ========================================================================== */

function PanelMessage({
  icon,
  children,
  tone: messageTone = "neutral",
}: {
  icon?: IconLike;
  children: ReactNode;
  tone?: Tone;
}) {
  return (
    <div
      className={cx(
        "flex items-center gap-2 px-3 py-6 text-body",
        messageTone === "neutral" ? "text-content-subtle" : toneStyles[messageTone].text,
      )}
    >
      <span className="flex w-full items-center justify-center gap-2 text-center">
        {icon ? renderIcon(icon, 14) : null}
        <span>{children}</span>
      </span>
    </div>
  );
}

function PanelLoading({ label = "Searching…" }: { label?: string }) {
  return (
    <div
      className="flex items-center justify-center gap-2 px-3 py-6 text-body text-content-subtle"
      role="status"
      aria-live="polite"
    >
      <IconSpinner size={14} />
      <span>{label}</span>
    </div>
  );
}

/** Skeleton rows for the very first async load, so the panel never jumps. */
function PanelSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-1 p-1.5" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center gap-2 px-1.5 py-1.5">
          <span className="skeleton size-4 rounded-full" />
          <span
            className="skeleton h-3 rounded-xs"
            style={{ width: `${52 + ((index * 17) % 34)}%` }}
          />
        </div>
      ))}
    </div>
  );
}

/** The clear (×) affordance shared by every control that can be emptied. */
function ClearButton({
  onClear,
  label = "Clear",
  size = 14,
  className,
}: {
  onClear: () => void;
  label?: string;
  size?: number;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      tabIndex={-1}
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        event.stopPropagation();
        onClear();
      }}
      className={cx(
        "grid shrink-0 place-items-center rounded text-content-subtle",
        "transition-colors hover:bg-surface-active hover:text-content",
        size <= 12 ? "size-4" : "size-5",
        className,
      )}
    >
      <IconClose size={size === 14 ? 12 : size} strokeWidth={2.25} />
    </button>
  );
}

/** The chevron every popover-backed field shows on its right edge. */
function FieldChevron({ open, px = 14 }: { open: boolean; px?: number }) {
  return (
    <IconChevronDown
      size={px}
      className={cx(
        "shrink-0 text-content-subtle transition-transform duration-fast",
        open && "rotate-180",
      )}
    />
  );
}

/* ==========================================================================
   SearchInput
   ========================================================================== */

export interface SearchInputProps {
  /** Controlled text. */
  value?: string;
  defaultValue?: string;
  /** Fires on every keystroke. */
  onValueChange?: (value: string) => void;
  /** Fires on the debounced value — wire your query to this one. */
  onSearch?: (value: string) => void;
  /** Debounce for `onSearch`, in ms. Default 250. `0` disables it. */
  debounce?: number;
  placeholder?: string;
  size?: InputSize;
  /** Show a spinner in place of the magnifier. */
  loading?: boolean;
  /** Show the clear affordance once there is text. Default `true`. */
  clearable?: boolean;
  onClear?: () => void;
  /**
   * A single-character global shortcut that focuses the field (e.g. `"/"`).
   * Rendered as a hint on the right edge while the field is empty and blurred.
   */
  shortcut?: string;
  disabled?: boolean;
  invalid?: boolean;
  autoFocus?: boolean;
  name?: string;
  id?: string;
  className?: string;
  inputClassName?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  onFocus?: () => void;
  onBlur?: () => void;
}

/**
 * A search field that debounces for you.
 *
 *   <SearchInput placeholder="Search RFIs" shortcut="/" onSearch={setQuery} />
 */
export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(
  function SearchInput(
    {
      value,
      defaultValue = "",
      onValueChange,
      onSearch,
      debounce = 250,
      placeholder = "Search…",
      size = "md",
      loading = false,
      clearable = true,
      onClear,
      shortcut,
      disabled,
      invalid,
      autoFocus,
      name,
      id,
      className,
      inputClassName,
      "aria-label": ariaLabel,
      "aria-labelledby": ariaLabelledBy,
      onKeyDown,
      onFocus,
      onBlur,
    },
    ref,
  ) {
    const [text, setText] = useControllableState(value, defaultValue, onValueChange);
    const debounced = useDebouncedValue(text, debounce);
    const emitSearch = useEvent(onSearch);
    const innerRef = useRef<HTMLInputElement | null>(null);
    const [focused, setFocused] = useState(false);
    const iconPx = SIZE_ICON[size];

    useEffect(() => {
      emitSearch(debounced);
    }, [debounced, emitSearch]);

    useImperativeHandle(ref, () => innerRef.current as HTMLInputElement, []);

    /* Global single-key shortcut, ignored while another field has focus. */
    useEffect(() => {
      if (!shortcut || disabled) return;
      const handler = (event: KeyboardEvent) => {
        if (event.key !== shortcut) return;
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        const target = event.target as HTMLElement | null;
        const tag = target?.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          target?.isContentEditable
        ) {
          return;
        }
        event.preventDefault();
        innerRef.current?.focus();
        innerRef.current?.select();
      };
      document.addEventListener("keydown", handler);
      return () => document.removeEventListener("keydown", handler);
    }, [shortcut, disabled]);

    const clear = useCallback(() => {
      setText("");
      onClear?.();
      innerRef.current?.focus();
    }, [onClear, setText]);

    const showShortcut = Boolean(shortcut) && !focused && text.length === 0;

    return (
      <div
        data-slot="search-input"
        className={cx(shellClass(size, invalid, disabled), SIZE_H[size], SIZE_PX[size], className)}
      >
        <span className="mr-1.5 flex shrink-0 items-center text-content-subtle">
          {loading ? <IconSpinner size={iconPx} /> : <IconSearch size={iconPx} />}
        </span>
        <input
          ref={innerRef}
          id={id}
          name={name}
          type="search"
          role="searchbox"
          autoComplete="off"
          spellCheck={false}
          autoFocus={autoFocus}
          disabled={disabled}
          value={text}
          placeholder={placeholder}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          aria-invalid={invalid || undefined}
          aria-busy={loading || undefined}
          onChange={(event: ChangeEvent<HTMLInputElement>) => setText(event.target.value)}
          onFocus={() => {
            setFocused(true);
            onFocus?.();
          }}
          onBlur={() => {
            setFocused(false);
            onBlur?.();
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && text) {
              event.preventDefault();
              event.stopPropagation();
              clear();
              return;
            }
            onKeyDown?.(event);
          }}
          className={cx(
            BARE_INPUT,
            "[&::-webkit-search-cancel-button]:appearance-none",
            inputClassName,
          )}
        />
        {clearable && text.length > 0 && !disabled ? (
          <ClearButton onClear={clear} label="Clear search" className="ml-1" />
        ) : null}
        {showShortcut ? (
          <Kbd
            keys={[shortcut ?? ""]}
            size="sm"
            className="ml-1.5 hidden shrink-0 sm:inline-flex"
          />
        ) : null}
      </div>
    );
  },
);

/* ==========================================================================
   Combobox
   ========================================================================== */

export interface ComboboxOption<TData = unknown> {
  /** Stable identity. This is what `onChange` reports. */
  value: string;
  /** Primary line. Also what local filtering matches against. */
  label: string;
  /** Secondary line, rendered muted under the label. */
  description?: ReactNode;
  /** Leading glyph or avatar. */
  icon?: IconLike;
  /** Right-aligned trailing content (a badge, a code, a count). */
  meta?: ReactNode;
  /** Optional section header this option is filed under. */
  group?: string;
  /** Extra strings the local filter should match. */
  keywords?: readonly string[];
  disabled?: boolean;
  /** Anything the caller wants back on selection. */
  data?: TData;
}

type NavItem<TData> =
  | { readonly kind: "option"; readonly option: ComboboxOption<TData> }
  | { readonly kind: "create"; readonly query: string };

type ListRow<TData> =
  | { readonly kind: "group"; readonly key: string; readonly label: string }
  | {
      readonly kind: "option";
      readonly key: string;
      readonly nav: number;
      readonly option: ComboboxOption<TData>;
    }
  | { readonly kind: "create"; readonly key: string; readonly nav: number; readonly query: string };

function defaultOptionFilter<TData>(option: ComboboxOption<TData>, query: string): boolean {
  const q = normalise(query.trim());
  if (!q) return true;
  const haystack = normalise(
    [
      option.label,
      typeof option.description === "string" ? option.description : "",
      option.group ?? "",
      ...(option.keywords ?? []),
    ].join(" "),
  );
  return q.split(/\s+/).every((token) => haystack.includes(token));
}

function buildRows<TData>(
  options: readonly ComboboxOption<TData>[],
  createQuery: string | null,
): { rows: ListRow<TData>[]; nav: NavItem<TData>[] } {
  const rows: ListRow<TData>[] = [];
  const nav: NavItem<TData>[] = [];

  const ungrouped: ComboboxOption<TData>[] = [];
  const groups = new Map<string, ComboboxOption<TData>[]>();
  for (const option of options) {
    if (option.group) {
      const bucket = groups.get(option.group);
      if (bucket) bucket.push(option);
      else groups.set(option.group, [option]);
    } else {
      ungrouped.push(option);
    }
  }

  const push = (option: ComboboxOption<TData>, keyPrefix: string) => {
    const index = nav.length;
    nav.push({ kind: "option", option });
    rows.push({
      kind: "option",
      key: `${keyPrefix}:${option.value}:${index}`,
      nav: index,
      option,
    });
  };

  for (const option of ungrouped) push(option, "u");
  for (const [name, bucket] of groups) {
    rows.push({ kind: "group", key: `g:${name}`, label: name });
    for (const option of bucket) push(option, `g:${name}`);
  }

  if (createQuery !== null) {
    const index = nav.length;
    nav.push({ kind: "create", query: createQuery });
    rows.push({ kind: "create", key: "create", nav: index, query: createQuery });
  }

  return { rows, nav };
}

export interface ComboboxProps<TData = unknown> {
  /** Controlled selection, by `ComboboxOption.value`. */
  value?: string | null;
  defaultValue?: string | null;
  onChange?: (value: string | null, option: ComboboxOption<TData> | null) => void;

  /** Static options. Filtered locally unless `filter={false}`. */
  options?: readonly ComboboxOption<TData>[];
  /**
   * Async source. Receives the debounced query and an AbortSignal.
   * Held in a ref — an inline arrow is safe.
   */
  loadOptions?: (
    query: string,
    signal: AbortSignal,
  ) => Promise<readonly ComboboxOption<TData>[]>;
  /** Debounce applied to `loadOptions`. Default 220ms. */
  debounce?: number;
  /**
   * Local filtering. `false` turns it off entirely — the right choice when the
   * server already filtered. A function replaces the default matcher.
   */
  filter?: false | ((option: ComboboxOption<TData>, query: string) => boolean);

  /** Offer a "Create …" row when the query matches nothing. */
  allowCreate?: boolean;
  createLabel?: (query: string) => ReactNode;
  /** Return an option to select it immediately; return nothing to just notify. */
  onCreate?: (
    query: string,
  ) => void | ComboboxOption<TData> | Promise<void | ComboboxOption<TData>>;

  placeholder?: string;
  emptyMessage?: ReactNode;
  loadingMessage?: string;
  size?: InputSize;
  clearable?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  required?: boolean;
  /** Emit a hidden input so the value posts with a native form. */
  name?: string;
  id?: string;
  className?: string;
  panelClassName?: string;
  /** Leading adornment on the closed field. Defaults to the option's own icon. */
  leading?: IconLike;
  /** Open the list as soon as the field receives focus. Default `false`. */
  openOnFocus?: boolean;
  /** Keep the list open after a selection. Default `false`. */
  keepOpenOnSelect?: boolean;
  autoFocus?: boolean;
  maxPanelHeight?: number;

  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  onQueryChange?: (query: string) => void;

  /** Replace a row's contents. The row chrome (padding, states) is kept. */
  renderOption?: (
    option: ComboboxOption<TData>,
    state: { active: boolean; selected: boolean; query: string },
  ) => ReactNode;
  /** Replace the closed field's rendering of the selected option. */
  renderValue?: (option: ComboboxOption<TData>) => ReactNode;
  /** Pinned to the bottom of the panel (shortcut hints, "manage…" links). */
  footer?: ReactNode;

  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  onBlur?: () => void;
}

/**
 * Single-select combobox with local or async options, full keyboard
 * navigation, grouping, and an optional create-new row.
 *
 *   <Combobox
 *     value={specId}
 *     onChange={setSpecId}
 *     loadOptions={(q, signal) => api.searchSpecs(q, signal)}
 *     allowCreate
 *     onCreate={(name) => api.createSpec(name)}
 *     placeholder="Spec section"
 *   />
 */
export function Combobox<TData = unknown>({
  value,
  defaultValue = null,
  onChange,
  options,
  loadOptions,
  debounce = 220,
  filter,
  allowCreate = false,
  createLabel,
  onCreate,
  placeholder = "Select…",
  emptyMessage = "No matches",
  loadingMessage = "Searching…",
  size = "md",
  clearable = true,
  disabled = false,
  invalid = false,
  required = false,
  name,
  id,
  className,
  panelClassName,
  leading,
  openOnFocus = false,
  keepOpenOnSelect = false,
  autoFocus,
  maxPanelHeight,
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  onQueryChange,
  renderOption,
  renderValue,
  footer,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  "aria-describedby": ariaDescribedBy,
  onBlur,
}: ComboboxProps<TData>) {
  const fieldId = useIsomorphicId(id);
  const listId = `${fieldId}-listbox`;
  const [open, setOpen] = useControllableState(controlledOpen, defaultOpen, onOpenChange);
  const [selected, setSelected] = useControllableState<string | null>(
    value,
    defaultValue,
    undefined,
  );
  const [query, setQueryState] = useState("");
  const [activeNav, setActiveNav] = useState(0);
  const [creating, setCreating] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rowRefs = useRef(new Map<number, HTMLElement>());
  /** Remembers the chosen option so the closed field keeps its label even when
      the async list no longer contains it. */
  const [resolved, setResolved] = useState<ComboboxOption<TData> | null>(null);
  const emitChange = useEvent(onChange);
  const emitQuery = useEvent(onQueryChange);

  const async = useAsyncOptions(loadOptions, query, open, debounce);
  const sourceOptions = loadOptions ? async.options : (options ?? []);

  const filtered = useMemo(() => {
    if (filter === false || loadOptions) return sourceOptions;
    const matcher = filter ?? defaultOptionFilter;
    if (!query.trim()) return sourceOptions;
    return sourceOptions.filter((option) => matcher(option, query));
  }, [sourceOptions, filter, query, loadOptions]);

  const trimmed = query.trim();
  const exactExists = useMemo(
    () => filtered.some((option) => normalise(option.label) === normalise(trimmed)),
    [filtered, trimmed],
  );
  const createQuery = allowCreate && trimmed.length > 0 && !exactExists ? trimmed : null;

  const { rows, nav } = useMemo(
    () => buildRows(filtered, createQuery),
    [filtered, createQuery],
  );

  /**
   * Resolve the selected option during render so a controlled `value` paints
   * its label on the very first frame, then remember it so the field keeps
   * that label after an async reload drops the option from the list.
   */
  const optionFromList = useMemo(
    () =>
      selected === null
        ? null
        : (sourceOptions.find((option) => option.value === selected) ?? null),
    [selected, sourceOptions],
  );

  useEffect(() => {
    if (selected === null) {
      setResolved(null);
      return;
    }
    if (optionFromList) setResolved(optionFromList);
  }, [optionFromList, selected]);

  /* Reset the highlight whenever the visible list changes shape. */
  useEffect(() => {
    if (!open) return;
    const selectedIndex = nav.findIndex(
      (item) => item.kind === "option" && item.option.value === selected,
    );
    setActiveNav(selectedIndex >= 0 ? selectedIndex : 0);
    // Intentionally not depending on `selected`: re-centring mid-typing is jarring.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, rows.length]);

  useEffect(() => {
    if (!open) return;
    const node = rowRefs.current.get(activeNav);
    node?.scrollIntoView({ block: "nearest" });
  }, [activeNav, open]);

  const setQuery = useCallback(
    (next: string) => {
      setQueryState(next);
      emitQuery(next);
    },
    [emitQuery],
  );

  const openList = useCallback(() => {
    if (disabled || open) return;
    setQuery("");
    setOpen(true);
  }, [disabled, open, setOpen, setQuery]);

  const closeList = useCallback(() => {
    setOpen(false);
    setQuery("");
    setActiveNav(0);
  }, [setOpen, setQuery]);

  const commit = useCallback(
    (option: ComboboxOption<TData> | null) => {
      if (option?.disabled) return;
      setSelected(option ? option.value : null);
      setResolved(option);
      emitChange(option ? option.value : null, option);
      if (!keepOpenOnSelect) closeList();
      else setQuery("");
      inputRef.current?.focus();
    },
    [closeList, emitChange, keepOpenOnSelect, setQuery, setSelected],
  );

  const runCreate = useCallback(
    async (text: string) => {
      if (!onCreate) return;
      setCreating(true);
      try {
        const created = await onCreate(text);
        if (created) commit(created);
        else closeList();
      } finally {
        setCreating(false);
      }
    },
    [closeList, commit, onCreate],
  );

  const activate = useCallback(
    (index: number) => {
      const item = nav[index];
      if (!item) return;
      if (item.kind === "create") {
        void runCreate(item.query);
        return;
      }
      commit(item.option);
    },
    [commit, nav, runCreate],
  );

  const move = useCallback(
    (delta: number) => {
      if (nav.length === 0) return;
      setActiveNav((current) => {
        let next = current + delta;
        while (next < 0) next += nav.length;
        next %= nav.length;
        /* Skip disabled rows, but never loop forever. */
        for (let guard = 0; guard < nav.length; guard += 1) {
          const item = nav[next];
          if (!item || item.kind === "create" || !item.option.disabled) return next;
          next = (next + (delta >= 0 ? 1 : nav.length - 1)) % nav.length;
        }
        return current;
      });
    },
    [nav],
  );

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (!open) openList();
        else move(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        if (!open) openList();
        else move(-1);
        break;
      case "PageDown":
        if (open) {
          event.preventDefault();
          move(8);
        }
        break;
      case "PageUp":
        if (open) {
          event.preventDefault();
          move(-8);
        }
        break;
      case "Home":
        if (open) {
          event.preventDefault();
          setActiveNav(0);
        }
        break;
      case "End":
        if (open) {
          event.preventDefault();
          setActiveNav(Math.max(0, nav.length - 1));
        }
        break;
      case "Enter":
        if (open) {
          event.preventDefault();
          activate(activeNav);
        }
        break;
      case "Tab":
        if (open) closeList();
        break;
      case "Backspace":
        if (!query && selected !== null) {
          event.preventDefault();
          commit(null);
        }
        break;
      default:
        break;
    }
  };

  const selectedOption =
    optionFromList ?? (resolved && resolved.value === selected ? resolved : null);
  const showCustomValue = Boolean(!open && selectedOption && renderValue);
  const displayValue = open ? query : (selectedOption?.label ?? "");
  const displayPlaceholder = open ? (selectedOption?.label ?? placeholder) : placeholder;
  const iconPx = SIZE_ICON[size];
  const listLoading = Boolean(loadOptions) && async.loading;
  const showEmpty = !listLoading && rows.length === 0;
  const firstLoad = listLoading && sourceOptions.length === 0;

  return (
    <div className={cx("relative w-full", className)} data-slot="combobox">
      <div
        ref={setAnchor}
        className={cx(shellClass(size, invalid, disabled), SIZE_H[size], SIZE_PX[size])}
        onMouseDown={(event: ReactMouseEvent<HTMLDivElement>) => {
          if (disabled) return;
          if ((event.target as HTMLElement).closest("button")) return;
          if (!open) openList();
        }}
      >
        {leading || (!open && selectedOption?.icon) ? (
          <span className="mr-1.5 flex shrink-0 items-center text-content-subtle">
            {renderIcon(leading ?? selectedOption?.icon, iconPx)}
          </span>
        ) : null}

        {/* A custom-rendered value takes the flow and the <input> drops to an
            invisible overlay, so the field keeps a real, focusable text
            control while showing an avatar / badge / code instead of a string. */}
        {showCustomValue && selectedOption ? (
          <span className="pointer-events-none min-w-0 flex-1 overflow-hidden">
            {renderValue?.(selectedOption)}
          </span>
        ) : null}

        <input
          ref={inputRef}
          id={fieldId}
          role="combobox"
          type="text"
          autoComplete="off"
          spellCheck={false}
          autoFocus={autoFocus}
          disabled={disabled}
          required={required}
          value={displayValue}
          placeholder={displayPlaceholder}
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={
            open && nav[activeNav] ? `${listId}-n${activeNav}` : undefined
          }
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          aria-describedby={ariaDescribedBy}
          aria-invalid={invalid || undefined}
          aria-required={required || undefined}
          onChange={(event) => {
            if (!open) setOpen(true);
            setQuery(event.target.value);
            setActiveNav(0);
          }}
          onFocus={() => {
            if (openOnFocus) openList();
          }}
          onBlur={onBlur}
          onKeyDown={handleKeyDown}
          className={cx(
            BARE_INPUT,
            showCustomValue
              ? "absolute inset-0 h-full w-full px-2.5 text-transparent caret-content"
              : selectedOption && !open
                ? "text-content"
                : undefined,
          )}
        />

        {/* `relative` keeps these above the input when it is overlaid for a
            custom-rendered value. */}
        {clearable && selectedOption && !disabled ? (
          <ClearButton
            onClear={() => commit(null)}
            label="Clear selection"
            className="relative ml-1"
          />
        ) : null}
        <button
          type="button"
          tabIndex={-1}
          disabled={disabled}
          aria-hidden="true"
          onMouseDown={(event) => {
            event.preventDefault();
            if (disabled) return;
            if (open) closeList();
            else openList();
            inputRef.current?.focus();
          }}
          className="relative ml-1 grid size-5 shrink-0 place-items-center rounded text-content-subtle hover:text-content"
        >
          <FieldChevron open={open} px={iconPx} />
        </button>
      </div>

      {name ? <input type="hidden" name={name} value={selected ?? ""} /> : null}

      <AnchoredPanel
        open={open}
        onOpenChange={(next) => (next ? openList() : closeList())}
        anchor={anchor}
        matchAnchorWidth
        maxHeight={maxPanelHeight}
        id={listId}
        role="listbox"
        ariaLabel={ariaLabel ?? "Options"}
        className={panelClassName}
      >
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5">
          {firstLoad ? <PanelSkeleton /> : null}
          {!firstLoad && async.error ? (
            <div className="px-3 py-6 text-center">
              <p className="text-body text-danger-fg">Could not load options</p>
              <button
                type="button"
                onClick={() => async.reload()}
                className="mt-2 inline-flex items-center gap-1.5 text-meta text-accent-text hover:underline"
              >
                <IconRefresh size={12} />
                Try again
              </button>
            </div>
          ) : null}
          {!firstLoad && !async.error && listLoading && rows.length === 0 ? (
            <PanelLoading label={loadingMessage} />
          ) : null}
          {!firstLoad && !async.error && showEmpty && !listLoading ? (
            <PanelMessage icon={IconSearch}>{emptyMessage}</PanelMessage>
          ) : null}

          {rows.map((row) => {
            if (row.kind === "group") {
              return (
                <div
                  key={row.key}
                  role="presentation"
                  className="px-2 pb-1 pt-2.5 text-label uppercase text-content-subtle"
                >
                  {row.label}
                </div>
              );
            }
            if (row.kind === "create") {
              const active = row.nav === activeNav;
              return (
                <div
                  key={row.key}
                  ref={(node) => {
                    if (node) rowRefs.current.set(row.nav, node);
                    else rowRefs.current.delete(row.nav);
                  }}
                  id={`${listId}-n${row.nav}`}
                  role="option"
                  aria-selected={false}
                  data-active={active}
                  onMouseEnter={() => setActiveNav(row.nav)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => void runCreate(row.query)}
                  className={cx(OPTION_ROW, "mt-1 border-t border-border-subtle pt-2")}
                >
                  {creating ? (
                    <IconSpinner size={14} className="text-accent-text" />
                  ) : (
                    <IconPlus size={14} className="text-accent-text" />
                  )}
                  <span className="min-w-0 flex-1 truncate">
                    {createLabel ? (
                      createLabel(row.query)
                    ) : (
                      <>
                        Create <span className="font-medium text-content">“{row.query}”</span>
                      </>
                    )}
                  </span>
                  <Kbd keys={["Enter"]} size="sm" className="opacity-0 group-data-[active=true]/opt:opacity-100" />
                </div>
              );
            }

            const active = row.nav === activeNav;
            const isSelected = row.option.value === selected;
            return (
              <div
                key={row.key}
                ref={(node) => {
                  if (node) rowRefs.current.set(row.nav, node);
                  else rowRefs.current.delete(row.nav);
                }}
                id={`${listId}-n${row.nav}`}
                role="option"
                aria-selected={isSelected}
                aria-disabled={row.option.disabled || undefined}
                data-active={active}
                data-disabled={row.option.disabled ? "true" : "false"}
                onMouseEnter={() => {
                  if (!row.option.disabled) setActiveNav(row.nav);
                }}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => commit(row.option)}
                className={OPTION_ROW}
              >
                {renderOption ? (
                  renderOption(row.option, { active, selected: isSelected, query })
                ) : (
                  <>
                    {row.option.icon ? (
                      <span className="flex shrink-0 items-center text-content-subtle">
                        {renderIcon(row.option.icon, 15)}
                      </span>
                    ) : null}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">
                        {highlightMatch(row.option.label, query)}
                      </span>
                      {row.option.description !== undefined ? (
                        <span className="mt-0.5 block truncate text-meta text-content-subtle">
                          {row.option.description}
                        </span>
                      ) : null}
                    </span>
                    {row.option.meta !== undefined ? (
                      <span className="shrink-0 text-meta text-content-subtle">
                        {row.option.meta}
                      </span>
                    ) : null}
                  </>
                )}
                <IconCheck
                  size={14}
                  className={cx(
                    "shrink-0 text-accent-text transition-opacity",
                    isSelected ? "opacity-100" : "opacity-0",
                  )}
                />
              </div>
            );
          })}
        </div>
        {footer ? (
          <div className="shrink-0 border-t border-border-subtle bg-surface-sunken/60 px-3 py-2 text-meta text-content-subtle">
            {footer}
          </div>
        ) : null}
      </AnchoredPanel>

      <VisuallyHidden>
        <span aria-live="polite">
          {open
            ? listLoading
              ? loadingMessage
              : `${nav.length} option${nav.length === 1 ? "" : "s"} available`
            : ""}
        </span>
      </VisuallyHidden>
    </div>
  );
}

/* ==========================================================================
   MultiSelect
   ========================================================================== */

export interface MultiSelectProps<TData = unknown> {
  value?: readonly string[];
  defaultValue?: readonly string[];
  onChange?: (value: string[], options: ComboboxOption<TData>[]) => void;

  options?: readonly ComboboxOption<TData>[];
  loadOptions?: (
    query: string,
    signal: AbortSignal,
  ) => Promise<readonly ComboboxOption<TData>[]>;
  debounce?: number;
  filter?: false | ((option: ComboboxOption<TData>, query: string) => boolean);

  placeholder?: string;
  emptyMessage?: ReactNode;
  loadingMessage?: string;
  size?: InputSize;
  disabled?: boolean;
  invalid?: boolean;
  required?: boolean;
  clearable?: boolean;
  name?: string;
  id?: string;
  className?: string;
  panelClassName?: string;

  /** Chips rendered before collapsing into a "+N" pill. Default 3. `0` = all. */
  maxVisible?: number;
  /** Cap the selection. The remaining rows go disabled once it is reached. */
  max?: number;
  /** Show the select-all / clear header. Default `true`. */
  showSelectAll?: boolean;
  /** Close the panel after each pick. Default `false` — multi-pick is the point. */
  closeOnSelect?: boolean;
  /** Tone used by the chips. Default `neutral`. */
  chipTone?: Tone;
  maxPanelHeight?: number;
  autoFocus?: boolean;

  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  onQueryChange?: (query: string) => void;

  renderOption?: (
    option: ComboboxOption<TData>,
    state: { active: boolean; selected: boolean; query: string },
  ) => ReactNode;
  renderChip?: (option: ComboboxOption<TData>) => ReactNode;
  footer?: ReactNode;

  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  onBlur?: () => void;
}

/**
 * Multi-select with chips, inline search, select-all and overflow collapsing.
 *
 *   <MultiSelect
 *     value={trades}
 *     onChange={setTrades}
 *     options={TRADE_OPTIONS}
 *     maxVisible={3}
 *     placeholder="Trades"
 *   />
 */
export function MultiSelect<TData = unknown>({
  value,
  defaultValue,
  onChange,
  options,
  loadOptions,
  debounce = 220,
  filter,
  placeholder = "Select…",
  emptyMessage = "No matches",
  loadingMessage = "Searching…",
  size = "md",
  disabled = false,
  invalid = false,
  required = false,
  clearable = true,
  name,
  id,
  className,
  panelClassName,
  maxVisible = 3,
  max,
  showSelectAll = true,
  closeOnSelect = false,
  chipTone = "neutral",
  maxPanelHeight,
  autoFocus,
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  onQueryChange,
  renderOption,
  renderChip,
  footer,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  "aria-describedby": ariaDescribedBy,
  onBlur,
}: MultiSelectProps<TData>) {
  const fieldId = useIsomorphicId(id);
  const listId = `${fieldId}-listbox`;
  const [open, setOpen] = useControllableState(controlledOpen, defaultOpen, onOpenChange);
  const [selected, setSelected] = useControllableState<readonly string[]>(
    value,
    defaultValue ?? [],
    undefined,
  );
  const [query, setQueryState] = useState("");
  const [activeNav, setActiveNav] = useState(0);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rowRefs = useRef(new Map<number, HTMLElement>());
  /** value → option, so chips survive an async list that no longer holds them. */
  const knownRef = useRef(new Map<string, ComboboxOption<TData>>());
  const [knownVersion, setKnownVersion] = useState(0);
  const emitChange = useEvent(onChange);
  const emitQuery = useEvent(onQueryChange);

  const async = useAsyncOptions(loadOptions, query, open, debounce);
  const sourceOptions = loadOptions ? async.options : (options ?? []);

  useEffect(() => {
    let added = false;
    for (const option of sourceOptions) {
      if (!knownRef.current.has(option.value)) {
        knownRef.current.set(option.value, option);
        added = true;
      }
    }
    if (added) setKnownVersion((n) => n + 1);
  }, [sourceOptions]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const filtered = useMemo(() => {
    if (filter === false || loadOptions) return sourceOptions;
    const matcher = filter ?? defaultOptionFilter;
    if (!query.trim()) return sourceOptions;
    return sourceOptions.filter((option) => matcher(option, query));
  }, [sourceOptions, filter, query, loadOptions]);

  const { rows, nav } = useMemo(() => buildRows(filtered, null), [filtered]);

  const atCapacity = typeof max === "number" && selected.length >= max;

  const chips = useMemo(
    () =>
      selected.map((id_) => {
        /* Prefer the live list so the first paint is already correct, then the
           cache, then a bare id so a chip is never blank. */
        const live = sourceOptions.find((option) => option.value === id_);
        if (live) return live;
        return (
          knownRef.current.get(id_) ?? ({ value: id_, label: id_ } as ComboboxOption<TData>)
        );
      }),
    // `knownVersion` ticks when the label cache learns a new option.
    [selected, sourceOptions, knownVersion],
  );

  const setQuery = useCallback(
    (next: string) => {
      setQueryState(next);
      emitQuery(next);
    },
    [emitQuery],
  );

  const apply = useCallback(
    (next: readonly string[]) => {
      const list = [...next];
      setSelected(list);
      emitChange(
        list,
        list.map(
          (id_) =>
            knownRef.current.get(id_) ?? ({ value: id_, label: id_ } as ComboboxOption<TData>),
        ),
      );
    },
    [emitChange, setSelected],
  );

  const toggle = useCallback(
    (option: ComboboxOption<TData>) => {
      if (option.disabled) return;
      if (selectedSet.has(option.value)) {
        apply(selected.filter((id_) => id_ !== option.value));
      } else {
        if (atCapacity) return;
        knownRef.current.set(option.value, option);
        apply([...selected, option.value]);
      }
      if (closeOnSelect) setOpen(false);
      inputRef.current?.focus();
    },
    [apply, atCapacity, closeOnSelect, selected, selectedSet, setOpen],
  );

  const openList = useCallback(() => {
    if (disabled || open) return;
    setOpen(true);
  }, [disabled, open, setOpen]);

  const closeList = useCallback(() => {
    setOpen(false);
    setQuery("");
    setActiveNav(0);
  }, [setOpen, setQuery]);

  useEffect(() => {
    if (!open) return;
    const node = rowRefs.current.get(activeNav);
    node?.scrollIntoView({ block: "nearest" });
  }, [activeNav, open]);

  useEffect(() => {
    if (open) setActiveNav(0);
  }, [open, rows.length]);

  const move = useCallback(
    (delta: number) => {
      if (nav.length === 0) return;
      setActiveNav((current) => {
        let next = current + delta;
        while (next < 0) next += nav.length;
        return next % nav.length;
      });
    },
    [nav.length],
  );

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (!open) openList();
        else move(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        if (!open) openList();
        else move(-1);
        break;
      case "Home":
        if (open) {
          event.preventDefault();
          setActiveNav(0);
        }
        break;
      case "End":
        if (open) {
          event.preventDefault();
          setActiveNav(Math.max(0, nav.length - 1));
        }
        break;
      case "Enter": {
        if (!open) break;
        event.preventDefault();
        const item = nav[activeNav];
        if (item && item.kind === "option") toggle(item.option);
        break;
      }
      case "Tab":
        if (open) closeList();
        break;
      case "Backspace": {
        if (query.length === 0 && selected.length > 0) {
          event.preventDefault();
          apply(selected.slice(0, -1));
        }
        break;
      }
      default:
        break;
    }
  };

  const visibleChips = maxVisible > 0 && !expanded ? chips.slice(0, maxVisible) : chips;
  const hiddenCount = chips.length - visibleChips.length;
  const listLoading = Boolean(loadOptions) && async.loading;
  const firstLoad = listLoading && sourceOptions.length === 0;
  const allVisibleSelected =
    filtered.length > 0 && filtered.every((option) => selectedSet.has(option.value));

  const chipSize = size === "lg" ? "md" : size === "xs" ? "xs" : "sm";

  return (
    <div className={cx("relative w-full", className)} data-slot="multi-select">
      <div
        ref={setAnchor}
        className={cx(
          shellClass(size, invalid, disabled),
          SIZE_MIN_H[size],
          "h-auto flex-wrap items-center gap-1 py-1",
          SIZE_PX[size],
        )}
        onMouseDown={(event: ReactMouseEvent<HTMLDivElement>) => {
          if (disabled) return;
          if ((event.target as HTMLElement).closest("button")) return;
          openList();
        }}
      >
        {visibleChips.map((option) => (
          <Tag
            key={option.value}
            size={chipSize}
            tone={chipTone}
            selected={chipTone !== "neutral"}
            icon={option.icon}
            removeLabel={`Remove ${option.label}`}
            onRemove={
              disabled
                ? undefined
                : () => apply(selected.filter((id_) => id_ !== option.value))
            }
            className="max-w-[14rem]"
          >
            {renderChip ? renderChip(option) : option.label}
          </Tag>
        ))}
        {hiddenCount > 0 ? (
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setExpanded(true)}
            className="inline-flex h-6 shrink-0 items-center rounded-md border border-border bg-surface-sunken px-1.5 text-meta font-medium text-content-muted hover:border-border-strong hover:text-content"
          >
            +{hiddenCount}
          </button>
        ) : null}

        <input
          ref={inputRef}
          id={fieldId}
          role="combobox"
          type="text"
          autoComplete="off"
          spellCheck={false}
          autoFocus={autoFocus}
          disabled={disabled}
          required={required && selected.length === 0}
          value={query}
          placeholder={chips.length === 0 ? placeholder : ""}
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={open && nav[activeNav] ? `${listId}-n${activeNav}` : undefined}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          aria-describedby={ariaDescribedBy}
          aria-invalid={invalid || undefined}
          onChange={(event) => {
            if (!open) setOpen(true);
            setQuery(event.target.value);
            setActiveNav(0);
          }}
          onBlur={onBlur}
          onKeyDown={handleKeyDown}
          className={cx(BARE_INPUT, "h-6 min-w-[4rem] flex-1")}
        />

        {clearable && chips.length > 0 && !disabled ? (
          <ClearButton onClear={() => apply([])} label="Clear all" className="ml-0.5" />
        ) : null}
        <button
          type="button"
          tabIndex={-1}
          disabled={disabled}
          aria-hidden="true"
          onMouseDown={(event) => {
            event.preventDefault();
            if (disabled) return;
            if (open) closeList();
            else openList();
            inputRef.current?.focus();
          }}
          className="ml-0.5 grid size-5 shrink-0 place-items-center rounded text-content-subtle hover:text-content"
        >
          <FieldChevron open={open} px={SIZE_ICON[size]} />
        </button>
      </div>

      {name
        ? selected.map((id_) => <input key={id_} type="hidden" name={name} value={id_} />)
        : null}

      <AnchoredPanel
        open={open}
        onOpenChange={(next) => (next ? openList() : closeList())}
        anchor={anchor}
        matchAnchorWidth
        maxHeight={maxPanelHeight}
        id={listId}
        role="listbox"
        ariaLabel={ariaLabel ?? "Options"}
        className={panelClassName}
      >
        {showSelectAll && filtered.length > 0 ? (
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border-subtle px-2.5 py-1.5">
            <span className="text-meta text-content-subtle">
              {selected.length} selected
              {typeof max === "number" ? ` / ${max}` : ""}
            </span>
            <span className="flex items-center gap-1">
              <button
                type="button"
                disabled={allVisibleSelected || atCapacity}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  const additions = filtered
                    .filter((option) => !option.disabled && !selectedSet.has(option.value))
                    .map((option) => {
                      knownRef.current.set(option.value, option);
                      return option.value;
                    });
                  const next = [...selected, ...additions];
                  apply(typeof max === "number" ? next.slice(0, max) : next);
                }}
                className="rounded px-1.5 py-0.5 text-meta font-medium text-accent-text hover:bg-accent-subtle disabled:pointer-events-none disabled:opacity-40"
              >
                Select all
              </button>
              <button
                type="button"
                disabled={selected.length === 0}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => apply([])}
                className="rounded px-1.5 py-0.5 text-meta font-medium text-content-muted hover:bg-surface-hover hover:text-content disabled:pointer-events-none disabled:opacity-40"
              >
                Clear
              </button>
            </span>
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5">
          {firstLoad ? <PanelSkeleton /> : null}
          {!firstLoad && async.error ? (
            <div className="px-3 py-6 text-center">
              <p className="text-body text-danger-fg">Could not load options</p>
              <button
                type="button"
                onClick={() => async.reload()}
                className="mt-2 inline-flex items-center gap-1.5 text-meta text-accent-text hover:underline"
              >
                <IconRefresh size={12} />
                Try again
              </button>
            </div>
          ) : null}
          {!firstLoad && !async.error && listLoading && rows.length === 0 ? (
            <PanelLoading label={loadingMessage} />
          ) : null}
          {!firstLoad && !async.error && !listLoading && rows.length === 0 ? (
            <PanelMessage icon={IconSearch}>{emptyMessage}</PanelMessage>
          ) : null}

          {rows.map((row) => {
            if (row.kind === "group") {
              return (
                <div
                  key={row.key}
                  role="presentation"
                  className="px-2 pb-1 pt-2.5 text-label uppercase text-content-subtle"
                >
                  {row.label}
                </div>
              );
            }
            if (row.kind === "create") return null;

            const active = row.nav === activeNav;
            const isSelected = selectedSet.has(row.option.value);
            const blocked = Boolean(row.option.disabled) || (atCapacity && !isSelected);
            return (
              <div
                key={row.key}
                ref={(node) => {
                  if (node) rowRefs.current.set(row.nav, node);
                  else rowRefs.current.delete(row.nav);
                }}
                id={`${listId}-n${row.nav}`}
                role="option"
                aria-selected={isSelected}
                aria-disabled={blocked || undefined}
                data-active={active}
                data-disabled={blocked ? "true" : "false"}
                onMouseEnter={() => {
                  if (!blocked) setActiveNav(row.nav);
                }}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  if (!blocked) toggle(row.option);
                }}
                className={OPTION_ROW}
              >
                <Checkbox
                  size="sm"
                  checked={isSelected}
                  disabled={blocked}
                  readOnly
                  tabIndex={-1}
                  aria-hidden="true"
                  className="pointer-events-none"
                />
                {renderOption ? (
                  renderOption(row.option, { active, selected: isSelected, query })
                ) : (
                  <>
                    {row.option.icon ? (
                      <span className="flex shrink-0 items-center text-content-subtle">
                        {renderIcon(row.option.icon, 15)}
                      </span>
                    ) : null}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">
                        {highlightMatch(row.option.label, query)}
                      </span>
                      {row.option.description !== undefined ? (
                        <span className="mt-0.5 block truncate text-meta text-content-subtle">
                          {row.option.description}
                        </span>
                      ) : null}
                    </span>
                    {row.option.meta !== undefined ? (
                      <span className="shrink-0 text-meta text-content-subtle">
                        {row.option.meta}
                      </span>
                    ) : null}
                  </>
                )}
              </div>
            );
          })}
        </div>
        {footer ? (
          <div className="shrink-0 border-t border-border-subtle bg-surface-sunken/60 px-3 py-2 text-meta text-content-subtle">
            {footer}
          </div>
        ) : null}
      </AnchoredPanel>
    </div>
  );
}

/* ==========================================================================
   UserPicker / VendorPicker
   --------------------------------------------------------------------------
   Both take a fetcher. Neither knows an endpoint.
   ========================================================================== */

export interface UserOption {
  id: string;
  name: string;
  email?: string | null;
  avatarUrl?: string | null;
  /** Job title or role — the secondary line when there is no email. */
  role?: string | null;
  company?: string | null;
  status?: "online" | "offline" | "busy" | "away";
  disabled?: boolean;
}

export interface VendorOption {
  id: string;
  name: string;
  /** Trading-as name, shown after the legal name. */
  tradeName?: string | null;
  /** Trade / discipline — the secondary line. */
  trade?: string | null;
  /** Vendor code, contract number, or CSI section. Right-aligned. */
  code?: string | null;
  logoUrl?: string | null;
  /** Any lifecycle string; rendered as a muted suffix when not "active". */
  status?: string | null;
  disabled?: boolean;
}

/** `(query, signal) => Promise<results>`. Called debounced, aborted on change. */
export type UserFetcher = (
  query: string,
  signal: AbortSignal,
) => Promise<readonly UserOption[]>;

export type VendorFetcher = (
  query: string,
  signal: AbortSignal,
) => Promise<readonly VendorOption[]>;

interface EntityPickerCommonProps {
  placeholder?: string;
  emptyMessage?: ReactNode;
  size?: InputSize;
  disabled?: boolean;
  invalid?: boolean;
  required?: boolean;
  clearable?: boolean;
  debounce?: number;
  name?: string;
  id?: string;
  className?: string;
  footer?: ReactNode;
  autoFocus?: boolean;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  onBlur?: () => void;
}

export interface UserPickerSingleProps extends EntityPickerCommonProps {
  multiple?: false;
  value?: string | null;
  defaultValue?: string | null;
  onChange?: (userId: string | null, user: UserOption | null) => void;
  /** Async source. Omit when passing a static `users` list. */
  fetchUsers?: UserFetcher;
  /** Static source. Filtered locally. */
  users?: readonly UserOption[];
  /** Show the email as the secondary line. Default `true`. */
  showEmail?: boolean;
}

export interface UserPickerMultipleProps
  extends Omit<UserPickerSingleProps, "multiple" | "value" | "defaultValue" | "onChange"> {
  multiple: true;
  value?: readonly string[];
  defaultValue?: readonly string[];
  onChange?: (userIds: string[], users: UserOption[]) => void;
  max?: number;
  maxVisible?: number;
}

export type UserPickerProps = UserPickerSingleProps | UserPickerMultipleProps;

function userToOption(user: UserOption, showEmail: boolean): ComboboxOption<UserOption> {
  const secondary = showEmail ? (user.email ?? user.role) : (user.role ?? user.email);
  return {
    value: user.id,
    label: user.name,
    description: secondary ?? undefined,
    disabled: user.disabled,
    keywords: [user.email ?? "", user.role ?? "", user.company ?? "", initialsFrom(user.name)],
    meta: user.company ?? undefined,
    data: user,
  };
}

function renderPersonRow(
  option: ComboboxOption<UserOption>,
  query: string,
): ReactNode {
  const user = option.data;
  return (
    <>
      <Avatar
        name={option.label}
        src={user?.avatarUrl ?? undefined}
        size="sm"
        status={user?.status}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{highlightMatch(option.label, query)}</span>
        {option.description !== undefined ? (
          <span className="mt-0.5 block truncate text-meta text-content-subtle">
            {typeof option.description === "string"
              ? highlightMatch(option.description, query)
              : option.description}
          </span>
        ) : null}
      </span>
      {user?.company ? (
        <span className="hidden shrink-0 truncate text-meta text-content-subtle sm:block">
          {user.company}
        </span>
      ) : null}
    </>
  );
}

/**
 * Person picker with avatars, a secondary line, and async search.
 *
 *   <UserPicker fetchUsers={(q, signal) => api.searchUsers(q, signal)}
 *               value={assigneeId} onChange={setAssigneeId} />
 *   <UserPicker multiple fetchUsers={search} value={ids} onChange={setIds} />
 */
export function UserPicker(props: UserPickerProps) {
  const {
    fetchUsers,
    users,
    showEmail = true,
    placeholder = "Search people…",
    emptyMessage = "No people found",
    size = "md",
    disabled,
    invalid,
    required,
    clearable = true,
    debounce = 220,
    name,
    id,
    className,
    footer,
    autoFocus,
    onBlur,
  } = props;

  const staticOptions = useMemo(
    () => (users ?? []).map((user) => userToOption(user, showEmail)),
    [users, showEmail],
  );

  const loadOptions = useMemo(() => {
    if (!fetchUsers) return undefined;
    return async (query: string, signal: AbortSignal) => {
      const found = await fetchUsers(query, signal);
      return found.map((user) => userToOption(user, showEmail));
    };
  }, [fetchUsers, showEmail]);

  const shared = {
    options: fetchUsers ? undefined : staticOptions,
    loadOptions,
    debounce,
    placeholder,
    emptyMessage,
    size,
    disabled,
    invalid,
    required,
    clearable,
    name,
    id,
    className,
    footer,
    autoFocus,
    onBlur,
    "aria-label": props["aria-label"] ?? "Person",
    "aria-labelledby": props["aria-labelledby"],
    "aria-describedby": props["aria-describedby"],
  } as const;

  if (props.multiple) {
    return (
      <MultiSelect<UserOption>
        {...shared}
        value={props.value}
        defaultValue={props.defaultValue}
        max={props.max}
        maxVisible={props.maxVisible ?? 3}
        onChange={(ids, options) =>
          props.onChange?.(
            ids,
            options.map(
              (option) =>
                option.data ?? ({ id: option.value, name: option.label } as UserOption),
            ),
          )
        }
        renderOption={(option, state) => renderPersonRow(option, state.query)}
        renderChip={(option) => (
          <span className="flex items-center gap-1.5">
            <Avatar
              name={option.label}
              src={option.data?.avatarUrl ?? undefined}
              size="2xs"
            />
            <span className="truncate">{option.label}</span>
          </span>
        )}
      />
    );
  }

  return (
    <Combobox<UserOption>
      {...shared}
      value={props.value}
      defaultValue={props.defaultValue ?? null}
      onChange={(userId, option) => props.onChange?.(userId, option?.data ?? null)}
      renderOption={(option, state) => renderPersonRow(option, state.query)}
      renderValue={(option) => (
        <span className="flex min-w-0 items-center gap-2">
          <Avatar name={option.label} src={option.data?.avatarUrl ?? undefined} size="xs" />
          <span className="truncate text-content">{option.label}</span>
        </span>
      )}
    />
  );
}

export interface VendorPickerSingleProps extends EntityPickerCommonProps {
  multiple?: false;
  value?: string | null;
  defaultValue?: string | null;
  onChange?: (vendorId: string | null, vendor: VendorOption | null) => void;
  fetchVendors?: VendorFetcher;
  vendors?: readonly VendorOption[];
}

export interface VendorPickerMultipleProps
  extends Omit<
    VendorPickerSingleProps,
    "multiple" | "value" | "defaultValue" | "onChange"
  > {
  multiple: true;
  value?: readonly string[];
  defaultValue?: readonly string[];
  onChange?: (vendorIds: string[], vendors: VendorOption[]) => void;
  max?: number;
  maxVisible?: number;
}

export type VendorPickerProps = VendorPickerSingleProps | VendorPickerMultipleProps;

function vendorToOption(vendor: VendorOption): ComboboxOption<VendorOption> {
  return {
    value: vendor.id,
    label: vendor.name,
    description: vendor.trade ?? vendor.tradeName ?? undefined,
    meta: vendor.code ?? undefined,
    disabled: vendor.disabled,
    keywords: [vendor.code ?? "", vendor.trade ?? "", vendor.tradeName ?? ""],
    data: vendor,
  };
}

function renderVendorRow(option: ComboboxOption<VendorOption>, query: string): ReactNode {
  const vendor = option.data;
  return (
    <>
      <Avatar
        name={option.label}
        src={vendor?.logoUrl ?? undefined}
        size="sm"
        shape="square"
        icon={IconVendor}
      />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate">{highlightMatch(option.label, query)}</span>
          {vendor?.status && vendor.status.toLowerCase() !== "active" ? (
            <span className="shrink-0 text-meta text-content-subtle">· {vendor.status}</span>
          ) : null}
        </span>
        {option.description !== undefined ? (
          <span className="mt-0.5 block truncate text-meta text-content-subtle">
            {typeof option.description === "string"
              ? highlightMatch(option.description, query)
              : option.description}
          </span>
        ) : null}
      </span>
      {vendor?.code ? (
        <span className="shrink-0 font-mono text-meta tabular-nums text-content-subtle">
          {vendor.code}
        </span>
      ) : null}
    </>
  );
}

/**
 * Vendor / subcontractor picker. Same shape as `UserPicker`, different row.
 *
 *   <VendorPicker fetchVendors={api.searchVendors} value={id} onChange={setId} />
 */
export function VendorPicker(props: VendorPickerProps) {
  const {
    fetchVendors,
    vendors,
    placeholder = "Search vendors…",
    emptyMessage = "No vendors found",
    size = "md",
    disabled,
    invalid,
    required,
    clearable = true,
    debounce = 220,
    name,
    id,
    className,
    footer,
    autoFocus,
    onBlur,
  } = props;

  const staticOptions = useMemo(
    () => (vendors ?? []).map(vendorToOption),
    [vendors],
  );

  const loadOptions = useMemo(() => {
    if (!fetchVendors) return undefined;
    return async (query: string, signal: AbortSignal) => {
      const found = await fetchVendors(query, signal);
      return found.map(vendorToOption);
    };
  }, [fetchVendors]);

  const shared = {
    options: fetchVendors ? undefined : staticOptions,
    loadOptions,
    debounce,
    placeholder,
    emptyMessage,
    size,
    disabled,
    invalid,
    required,
    clearable,
    name,
    id,
    className,
    footer,
    autoFocus,
    onBlur,
    "aria-label": props["aria-label"] ?? "Vendor",
    "aria-labelledby": props["aria-labelledby"],
    "aria-describedby": props["aria-describedby"],
  } as const;

  if (props.multiple) {
    return (
      <MultiSelect<VendorOption>
        {...shared}
        value={props.value}
        defaultValue={props.defaultValue}
        max={props.max}
        maxVisible={props.maxVisible ?? 3}
        onChange={(ids, options) =>
          props.onChange?.(
            ids,
            options.map(
              (option) =>
                option.data ?? ({ id: option.value, name: option.label } as VendorOption),
            ),
          )
        }
        renderOption={(option, state) => renderVendorRow(option, state.query)}
        renderChip={(option) => (
          <span className="flex items-center gap-1.5">
            <IconVendor size={12} className="text-content-subtle" />
            <span className="truncate">{option.label}</span>
          </span>
        )}
      />
    );
  }

  return (
    <Combobox<VendorOption>
      {...shared}
      value={props.value}
      defaultValue={props.defaultValue ?? null}
      onChange={(vendorId, option) => props.onChange?.(vendorId, option?.data ?? null)}
      renderOption={(option, state) => renderVendorRow(option, state.query)}
      renderValue={(option) => (
        <span className="flex min-w-0 items-center gap-2">
          <Avatar
            name={option.label}
            src={option.data?.logoUrl ?? undefined}
            size="xs"
            shape="square"
            icon={IconVendor}
          />
          <span className="truncate text-content">{option.label}</span>
        </span>
      )}
    />
  );
}

/* ==========================================================================
   Calendar — react-day-picker, wearing our tokens
   ========================================================================== */

const CAL_NAV_BUTTON =
  "grid size-7 place-items-center rounded-md border border-border bg-surface-raised " +
  "text-content-muted transition-colors hover:bg-surface-hover hover:text-content " +
  "disabled:pointer-events-none disabled:opacity-35";

const CAL_DAY_BUTTON =
  "relative flex size-8 items-center justify-center rounded-md text-body tabular-nums " +
  "text-content transition-colors hover:bg-surface-hover " +
  "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring " +
  "disabled:pointer-events-none";

/**
 * Class map for DayPicker. Range mode has to be styled differently: DayPicker
 * marks *every* day between the endpoints `selected`, so painting `selected`
 * as a solid pill would fill the whole range. In range mode the endpoints do
 * the work and `selected` stays empty.
 */
function calendarClassNames(mode: string | undefined) {
  const isRange = mode === "range";
  return {
    [UI.Root]: "relative",
    [UI.Months]: "flex flex-col gap-4 sm:flex-row sm:gap-5",
    [UI.Month]: "flex flex-col gap-1.5",
    [UI.MonthCaption]: "flex h-7 items-center justify-center px-9",
    [UI.CaptionLabel]: "text-body font-semibold text-content",
    [UI.Nav]: "absolute inset-x-0 top-0 flex h-7 items-center justify-between",
    [UI.PreviousMonthButton]: CAL_NAV_BUTTON,
    [UI.NextMonthButton]: CAL_NAV_BUTTON,
    /* `border-separate` (not collapse): a collapsed table ignores
       `border-radius` on its cells, which would square off the rounded ends
       of a selected range. */
    [UI.MonthGrid]: "w-full border-separate border-spacing-0",
    [UI.Weekdays]: "",
    [UI.Weekday]:
      "size-8 pb-1 text-center align-middle text-meta font-medium text-content-subtle",
    [UI.Weeks]: "",
    [UI.Week]: "",
    [UI.Day]:
      "relative size-8 p-0 text-center align-middle focus-within:relative focus-within:z-10",
    [UI.DayButton]: CAL_DAY_BUTTON,
    [UI.WeekNumber]:
      "size-8 text-center align-middle font-mono text-2xs tabular-nums text-content-subtle",
    [UI.WeekNumberHeader]: "size-8",
    [UI.Dropdowns]: "flex items-center gap-1.5",
    [UI.DropdownRoot]:
      "relative inline-flex h-7 items-center gap-1 rounded-md border border-border " +
      "bg-surface-raised px-2 text-body font-medium text-content hover:bg-surface-hover " +
      "focus-within:border-accent",
    [UI.Dropdown]: "absolute inset-0 cursor-pointer opacity-0",
    [UI.MonthsDropdown]: "",
    [UI.YearsDropdown]: "",
    [UI.Footer]: "pt-2 text-meta text-content-subtle",
    [UI.Chevron]: "",
    [DayFlag.today]:
      "[&>button]:font-semibold [&>button]:text-accent-text [&>button]:ring-1 " +
      "[&>button]:ring-inset [&>button]:ring-accent-border",
    [DayFlag.outside]: "[&>button]:text-content-disabled",
    [DayFlag.disabled]:
      "[&>button]:pointer-events-none [&>button]:text-content-disabled [&>button]:opacity-55",
    [DayFlag.hidden]: "invisible",
    [DayFlag.focused]: "",
    [SelectionState.selected]: isRange
      ? ""
      : "[&>button]:bg-accent [&>button]:font-semibold [&>button]:text-accent-fg " +
        "[&>button]:ring-0 [&>button]:hover:bg-accent-hover",
    [SelectionState.range_start]:
      "rounded-l-md bg-accent-subtle [&>button]:bg-accent [&>button]:font-semibold " +
      "[&>button]:text-accent-fg [&>button]:ring-0 [&>button]:hover:bg-accent-hover",
    [SelectionState.range_end]:
      "rounded-r-md bg-accent-subtle [&>button]:bg-accent [&>button]:font-semibold " +
      "[&>button]:text-accent-fg [&>button]:ring-0 [&>button]:hover:bg-accent-hover",
    [SelectionState.range_middle]:
      "bg-accent-subtle [&>button]:rounded-none [&>button]:text-accent-subtle-fg " +
      "[&>button]:ring-0 [&>button]:hover:bg-accent-subtle-hover",
  };
}

function CalendarChevron({
  orientation,
  className,
}: {
  orientation?: "up" | "down" | "left" | "right";
  className?: string;
}) {
  const Glyph =
    orientation === "left"
      ? IconChevronLeft
      : orientation === "right"
        ? IconChevronRight
        : IconChevronDown;
  return <Glyph size={15} className={className} />;
}

/** First date in whatever shape `selected` came in as. */
function selectionMonth(selection: unknown): Date | undefined {
  if (selection instanceof Date) return selection;
  if (Array.isArray(selection)) {
    const first = selection.find((entry) => entry instanceof Date);
    return first instanceof Date ? first : undefined;
  }
  if (typeof selection === "object" && selection !== null && "from" in selection) {
    const from = (selection as { from?: unknown }).from;
    return from instanceof Date ? from : undefined;
  }
  return undefined;
}

export type CalendarProps = DayPickerProps;

/**
 * DayPicker with the design system's classes already applied. Every DayPicker
 * prop passes through, so `mode`, `disabled`, `modifiers`, `numberOfMonths`
 * and friends behave exactly as documented upstream.
 */
export function Calendar(props: CalendarProps) {
  const mode = (props as { mode?: string }).mode;
  /**
   * DayPicker opens on the *current* month even when something far away is
   * selected. Land on the selection instead — it is what every caller means.
   */
  const selection = (props as { selected?: unknown }).selected;
  const fallbackMonth =
    props.month === undefined && props.defaultMonth === undefined
      ? selectionMonth(selection)
      : undefined;

  const merged = {
    ...props,
    ...(fallbackMonth ? { defaultMonth: fallbackMonth } : null),
    className: cx("select-none", props.className),
    classNames: { ...calendarClassNames(mode), ...props.classNames },
    components: { Chevron: CalendarChevron, ...props.components },
  } as unknown as DayPickerProps;
  return <DayPicker {...merged} />;
}

/* ==========================================================================
   Date parsing / formatting helpers
   ========================================================================== */

/** "dmy" for most of the world, "mdy" for en-US, "ymd" for ISO-ish locales. */
function inferDateOrder(locale?: string): "dmy" | "mdy" | "ymd" {
  try {
    const parts = new Intl.DateTimeFormat(locale, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(2024, 10, 22));
    const order = parts
      .filter((part) => part.type === "day" || part.type === "month" || part.type === "year")
      .map((part) => part.type.charAt(0))
      .join("");
    if (order === "mdy" || order === "dmy" || order === "ymd") return order;
  } catch {
    /* fall through */
  }
  return "dmy";
}

const RELATIVE_WORDS: Record<string, number> = {
  today: 0,
  tod: 0,
  now: 0,
  tomorrow: 1,
  tom: 1,
  tmr: 1,
  yesterday: -1,
  yest: -1,
};

const WEEKDAY_INDEX: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

/**
 * Parse everything a site engineer might type into a date field:
 * `2026-03-05`, `5/3/26`, `5 Mar`, `Mar 5 2026`, `today`, `tomorrow`, `fri`,
 * `+10`, `+3w`, `-2d`, `eom`, `eow`.
 *
 * Returns `null` when nothing sensible can be read.
 */
export function parseDateInput(
  text: string,
  options: { reference?: Date; locale?: string } = {},
): Date | null {
  const raw = text.trim();
  if (!raw) return null;
  const reference = startOfDay(options.reference ?? new Date());
  const lower = raw.toLowerCase();

  const word = RELATIVE_WORDS[lower];
  if (word !== undefined) return addDays(reference, word);
  if (lower === "eom") return endOfMonth(reference);
  if (lower === "som") return startOfMonth(reference);
  if (lower === "eow") return endOfWeek(reference, { weekStartsOn: 1 });
  if (lower === "sow") return startOfWeek(reference, { weekStartsOn: 1 });

  const weekday = WEEKDAY_INDEX[lower];
  if (weekday !== undefined) {
    const delta = (weekday - reference.getDay() + 7) % 7;
    return addDays(reference, delta === 0 ? 7 : delta);
  }

  const offset_ = /^([+-])\s*(\d{1,4})\s*(d|w|m|y)?$/.exec(lower);
  if (offset_) {
    const sign = offset_[1] === "-" ? -1 : 1;
    const amount = Number(offset_[2] ?? "0") * sign;
    const unit = offset_[3] ?? "d";
    if (unit === "d") return addDays(reference, amount);
    if (unit === "w") return addDays(reference, amount * 7);
    if (unit === "m") return addMonths(reference, amount);
    return addMonths(reference, amount * 12);
  }

  const order = inferDateOrder(options.locale);
  const numeric = order === "mdy" ? ["M/d/yyyy", "M/d/yy", "M/d"] : ["d/M/yyyy", "d/M/yy", "d/M"];
  const candidates = [
    "yyyy-MM-dd",
    "yyyy/MM/dd",
    ...numeric,
    ...numeric.map((pattern) => pattern.replace(/\//g, "-")),
    ...numeric.map((pattern) => pattern.replace(/\//g, ".")),
    "d MMM yyyy",
    "d MMMM yyyy",
    "MMM d yyyy",
    "MMMM d yyyy",
    "d MMM",
    "MMM d",
    "ddMMyyyy",
    "yyyyMMdd",
  ];

  const cleaned = raw.replace(/(\d)(st|nd|rd|th)\b/gi, "$1").replace(/,/g, "");
  for (const pattern of candidates) {
    const parsed = parseDateFns(cleaned, pattern, reference);
    if (isValidDate(parsed)) return startOfDay(parsed);
  }
  return null;
}

function clampDate(date: Date, min?: Date, max?: Date): Date {
  if (min && date.getTime() < startOfDay(min).getTime()) return startOfDay(min);
  if (max && date.getTime() > startOfDay(max).getTime()) return startOfDay(max);
  return date;
}

function relativeDayHint(date: Date, reference = new Date()): string | null {
  const delta = differenceInCalendarDays(date, reference);
  if (delta === 0) return "Today";
  if (delta === 1) return "Tomorrow";
  if (delta === -1) return "Yesterday";
  if (delta > 1 && delta <= 30) return `In ${delta} days`;
  if (delta < -1 && delta >= -30) return `${Math.abs(delta)} days ago`;
  return null;
}

/* ==========================================================================
   DatePicker
   ========================================================================== */

export interface DatePreset {
  /** Row label. */
  label: string;
  /** The date, or a factory evaluated when the row is clicked. */
  date: Date | (() => Date);
  /** Muted right-hand hint. Defaults to the resolved date. */
  hint?: string;
}

function defaultDatePresets(): DatePreset[] {
  return [
    { label: "Today", date: () => startOfDay(new Date()) },
    { label: "Tomorrow", date: () => addDays(startOfDay(new Date()), 1) },
    { label: "In 3 days", date: () => addDays(startOfDay(new Date()), 3) },
    {
      label: "Next week",
      date: () => startOfWeek(addDays(startOfDay(new Date()), 7), { weekStartsOn: 1 }),
    },
    { label: "In 2 weeks", date: () => addDays(startOfDay(new Date()), 14) },
    { label: "End of month", date: () => endOfMonth(new Date()) },
  ];
}

export interface DatePickerProps {
  value?: Date | null;
  defaultValue?: Date | null;
  onChange?: (date: Date | null) => void;

  /** Earliest selectable day (inclusive). Also bounds calendar navigation. */
  min?: Date;
  /** Latest selectable day (inclusive). */
  max?: Date;
  /** Any DayPicker matcher: dates, ranges, `{ dayOfWeek: [0, 6] }`, predicates. */
  disabledDates?: Matcher | Matcher[];

  /** Quick rows on the left. `false` hides the rail; omit for the defaults. */
  presets?: DatePreset[] | false;
  /** date-fns pattern for the closed field. Default `"d MMM yyyy"`. */
  format?: string;
  placeholder?: string;
  /** Let the user type a date. Default `true`. */
  allowTyping?: boolean;
  clearable?: boolean;
  /** Show "Today"/"In 4 days" beside the value. Default `true`. */
  showRelativeHint?: boolean;

  size?: InputSize;
  disabled?: boolean;
  invalid?: boolean;
  required?: boolean;
  readOnly?: boolean;
  name?: string;
  id?: string;
  className?: string;
  weekStartsOn?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  numberOfMonths?: number;
  showWeekNumbers?: boolean;
  /** Extra content pinned under the calendar. */
  footer?: ReactNode;

  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;

  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  onBlur?: () => void;
}

/**
 * Single-date field: type it, or pick it.
 *
 *   <DatePicker value={dueOn} onChange={setDueOn} min={new Date()} />
 */
export function DatePicker({
  value,
  defaultValue = null,
  onChange,
  min,
  max,
  disabledDates,
  presets,
  format: pattern = "d MMM yyyy",
  placeholder = "Pick a date",
  allowTyping = true,
  clearable = true,
  showRelativeHint = true,
  size = "md",
  disabled = false,
  invalid = false,
  required = false,
  readOnly = false,
  name,
  id,
  className,
  weekStartsOn = 1,
  numberOfMonths = 1,
  showWeekNumbers = false,
  footer,
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  "aria-describedby": ariaDescribedBy,
  onBlur,
}: DatePickerProps) {
  const fieldId = useIsomorphicId(id);
  const panelId = `${fieldId}-calendar`;
  const [open, setOpen] = useControllableState(controlledOpen, defaultOpen, onOpenChange);
  const [selected, setSelected] = useControllableState<Date | null>(
    value,
    defaultValue,
    undefined,
  );
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const [month, setMonth] = useState<Date>(() => selected ?? new Date());
  const inputRef = useRef<HTMLInputElement | null>(null);
  const emitChange = useEvent(onChange);

  const rows = presets === false ? [] : (presets ?? defaultDatePresets());
  const typable = allowTyping && !readOnly && !disabled;

  useEffect(() => {
    if (selected) setMonth(selected);
  }, [selected]);

  const commit = useCallback(
    (next: Date | null, closePanel = true) => {
      const normalised = next ? startOfDay(next) : null;
      setSelected(normalised);
      emitChange(normalised);
      if (normalised) setMonth(normalised);
      if (closePanel) setOpen(false);
    },
    [emitChange, setOpen, setSelected],
  );

  const commitTyped = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed) {
      if (selected) commit(null, false);
      return;
    }
    const parsed = parseDateInput(trimmed, { reference: new Date() });
    if (parsed) commit(clampDate(parsed, min, max), false);
    else setText(selected ? formatDate(selected, pattern) : "");
  }, [commit, max, min, pattern, selected, text]);

  const display = focused && typable ? text : selected ? formatDate(selected, pattern) : "";
  const iconPx = SIZE_ICON[size];
  const hint = showRelativeHint && selected && !focused ? relativeDayHint(selected) : null;

  const disabledMatchers = useMemo(() => {
    const list: Matcher[] = [];
    if (min) list.push({ before: startOfDay(min) });
    if (max) list.push({ after: startOfDay(max) });
    if (Array.isArray(disabledDates)) list.push(...disabledDates);
    else if (disabledDates !== undefined) list.push(disabledDates);
    return list;
  }, [disabledDates, max, min]);

  return (
    <div className={cx("relative w-full", className)} data-slot="date-picker">
      <div
        ref={setAnchor}
        className={cx(shellClass(size, invalid, disabled), SIZE_H[size], SIZE_PX[size])}
        onMouseDown={(event: ReactMouseEvent<HTMLDivElement>) => {
          if (disabled) return;
          if ((event.target as HTMLElement).closest("button")) return;
          if (!typable) {
            event.preventDefault();
            setOpen(!open);
          }
        }}
      >
        <IconCalendar size={iconPx} className="mr-1.5 shrink-0 text-content-subtle" />
        <input
          ref={inputRef}
          id={fieldId}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          readOnly={!typable}
          required={required}
          value={display}
          placeholder={placeholder}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          aria-describedby={ariaDescribedBy}
          aria-invalid={invalid || undefined}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          onFocus={() => {
            setFocused(true);
            setText(selected ? formatDate(selected, pattern) : "");
          }}
          onBlur={() => {
            setFocused(false);
            if (typable) commitTyped();
            onBlur?.();
          }}
          onChange={(event) => {
            setText(event.target.value);
            const preview = parseDateInput(event.target.value, { reference: new Date() });
            if (preview) setMonth(preview);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              /* A single-line field has no vertical caret motion to steal. */
              event.preventDefault();
              setOpen(true);
              return;
            }
            if (event.key === "Enter") {
              event.preventDefault();
              if (typable) commitTyped();
              setOpen(false);
            }
          }}
          className={cx(BARE_INPUT, !typable && "cursor-pointer")}
        />
        {hint ? (
          <span className="ml-1.5 shrink-0 text-meta text-content-subtle">{hint}</span>
        ) : null}
        {clearable && selected && !disabled && !readOnly ? (
          <ClearButton onClear={() => commit(null)} label="Clear date" className="ml-1" />
        ) : null}
        <button
          type="button"
          tabIndex={-1}
          disabled={disabled}
          aria-label="Open calendar"
          onMouseDown={(event) => {
            event.preventDefault();
            if (!disabled) setOpen(!open);
          }}
          className="ml-1 grid size-5 shrink-0 place-items-center rounded text-content-subtle hover:text-content"
        >
          <FieldChevron open={open} px={iconPx} />
        </button>
      </div>

      {name ? (
        <input
          type="hidden"
          name={name}
          value={selected ? formatDate(selected, "yyyy-MM-dd") : ""}
        />
      ) : null}

      <AnchoredPanel
        open={open}
        onOpenChange={setOpen}
        anchor={anchor}
        minAnchorWidth
        trapFocus
        role="dialog"
        id={panelId}
        ariaLabel={ariaLabel ?? "Choose a date"}
        maxHeight={520}
      >
        <div className="flex min-h-0 flex-1">
          {rows.length > 0 ? (
            <div className="w-36 shrink-0 overflow-y-auto border-r border-border-subtle p-1.5">
              {rows.map((preset) => {
                const resolved =
                  typeof preset.date === "function" ? preset.date() : preset.date;
                const isActive =
                  selected !== null &&
                  differenceInCalendarDays(resolved, selected) === 0;
                return (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => commit(clampDate(resolved, min, max))}
                    className={cx(
                      "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5",
                      "text-left text-body transition-colors hover:bg-surface-hover",
                      isActive
                        ? "bg-accent-subtle font-medium text-accent-subtle-fg"
                        : "text-content",
                    )}
                  >
                    <span className="truncate">{preset.label}</span>
                    <span className="shrink-0 text-meta tabular-nums text-content-subtle">
                      {preset.hint ?? formatDate(resolved, "d MMM")}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}

          <div className="min-w-0 flex-1 overflow-y-auto p-3">
            <Calendar
              mode="single"
              selected={selected ?? undefined}
              onSelect={(date) => commit(date ?? null)}
              month={month}
              onMonthChange={setMonth}
              startMonth={min}
              endMonth={max}
              disabled={disabledMatchers}
              weekStartsOn={weekStartsOn}
              numberOfMonths={numberOfMonths}
              showWeekNumber={showWeekNumbers}
              showOutsideDays
              autoFocus
            />
            {footer ? (
              <div className="mt-2 border-t border-border-subtle pt-2">{footer}</div>
            ) : null}
          </div>
        </div>
      </AnchoredPanel>
    </div>
  );
}

/* ==========================================================================
   DateRangePicker
   ========================================================================== */

export interface DateRangeValue {
  from: Date | null;
  to: Date | null;
}

export interface DateRangePreset {
  /** Stable key, also used to mark the active row. */
  key: string;
  label: string;
  range: () => DateRangeValue;
}

/**
 * The standard operational range set. Pass `weekStartsOn` to match the
 * project's calendar convention.
 */
export function buildRangePresets(
  options: { weekStartsOn?: 0 | 1 | 2 | 3 | 4 | 5 | 6 } = {},
): DateRangePreset[] {
  const weekStartsOn = options.weekStartsOn ?? 1;
  const today = () => startOfDay(new Date());
  return [
    { key: "today", label: "Today", range: () => ({ from: today(), to: today() }) },
    {
      key: "last7",
      label: "Last 7 days",
      range: () => ({ from: subDays(today(), 6), to: today() }),
    },
    {
      key: "this-week",
      label: "This week",
      range: () => ({
        from: startOfWeek(today(), { weekStartsOn }),
        to: endOfWeek(today(), { weekStartsOn }),
      }),
    },
    {
      key: "this-month",
      label: "This month",
      range: () => ({ from: startOfMonth(today()), to: endOfMonth(today()) }),
    },
    {
      key: "last30",
      label: "Last 30 days",
      range: () => ({ from: subDays(today(), 29), to: today() }),
    },
    {
      key: "last-month",
      label: "Last month",
      range: () => {
        const previous = subMonths(today(), 1);
        return { from: startOfMonth(previous), to: endOfMonth(previous) };
      },
    },
    {
      key: "this-quarter",
      label: "This quarter",
      range: () => ({ from: startOfQuarter(today()), to: endOfQuarter(today()) }),
    },
    {
      key: "last90",
      label: "Last 90 days",
      range: () => ({ from: subDays(today(), 89), to: today() }),
    },
    {
      key: "ytd",
      label: "Year to date",
      range: () => ({ from: startOfYear(today()), to: today() }),
    },
  ];
}

function sameRange(a: DateRangeValue, b: DateRangeValue): boolean {
  const eq = (x: Date | null, y: Date | null) =>
    x === null || y === null
      ? x === y
      : differenceInCalendarDays(x, y) === 0;
  return eq(a.from, b.from) && eq(a.to, b.to);
}

export interface DateRangePickerProps {
  value?: DateRangeValue | null;
  defaultValue?: DateRangeValue | null;
  onChange?: (range: DateRangeValue | null) => void;

  min?: Date;
  max?: Date;
  disabledDates?: Matcher | Matcher[];
  /** Replace the preset rail. `false` hides it. */
  presets?: DateRangePreset[] | false;
  format?: string;
  placeholder?: string;
  clearable?: boolean;
  /** Months shown side by side. Default 2. */
  numberOfMonths?: number;
  weekStartsOn?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  /** Longest selectable span, in days. */
  maxDays?: number;

  size?: InputSize;
  disabled?: boolean;
  invalid?: boolean;
  required?: boolean;
  name?: string;
  id?: string;
  className?: string;
  footer?: ReactNode;

  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;

  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
}

/**
 * Range field with a preset rail and a two-month calendar.
 *
 *   <DateRangePicker value={range} onChange={setRange} maxDays={366} />
 */
export function DateRangePicker({
  value,
  defaultValue = null,
  onChange,
  min,
  max,
  disabledDates,
  presets,
  format: pattern = "d MMM yyyy",
  placeholder = "Select a range",
  clearable = true,
  numberOfMonths = 2,
  weekStartsOn = 1,
  maxDays,
  size = "md",
  disabled = false,
  invalid = false,
  required = false,
  name,
  id,
  className,
  footer,
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  "aria-describedby": ariaDescribedBy,
}: DateRangePickerProps) {
  const fieldId = useIsomorphicId(id);
  const panelId = `${fieldId}-range`;
  const [open, setOpen] = useControllableState(controlledOpen, defaultOpen, onOpenChange);
  const [range, setRange] = useControllableState<DateRangeValue | null>(
    value,
    defaultValue,
    undefined,
  );
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [month, setMonth] = useState<Date>(() => range?.from ?? new Date());
  const emitChange = useEvent(onChange);

  const rows = presets === false ? [] : (presets ?? buildRangePresets({ weekStartsOn }));

  const commit = useCallback(
    (next: DateRangeValue | null, closePanel: boolean) => {
      setRange(next);
      emitChange(next);
      if (closePanel) setOpen(false);
    },
    [emitChange, setOpen, setRange],
  );

  const disabledMatchers = useMemo(() => {
    const list: Matcher[] = [];
    if (min) list.push({ before: startOfDay(min) });
    if (max) list.push({ after: startOfDay(max) });
    if (Array.isArray(disabledDates)) list.push(...disabledDates);
    else if (disabledDates !== undefined) list.push(disabledDates);
    return list;
  }, [disabledDates, max, min]);

  const activePreset = useMemo(() => {
    if (!range) return null;
    return rows.find((preset) => sameRange(preset.range(), range))?.key ?? "custom";
  }, [range, rows]);

  const label = useMemo(() => {
    if (!range?.from) return null;
    if (!range.to || differenceInCalendarDays(range.from, range.to) === 0) {
      return formatDate(range.from, pattern);
    }
    const sameYear = range.from.getFullYear() === range.to.getFullYear();
    const left = sameYear ? formatDate(range.from, "d MMM") : formatDate(range.from, pattern);
    return `${left} – ${formatDate(range.to, pattern)}`;
  }, [pattern, range]);

  const spanDays =
    range?.from && range.to ? differenceInCalendarDays(range.to, range.from) + 1 : null;

  return (
    <div className={cx("relative w-full", className)} data-slot="date-range-picker">
      {/* A div, not a <button>: the clear affordance is a real button and
          buttons cannot nest. Keyboard semantics are supplied explicitly. */}
      <div
        ref={setAnchor}
        role="button"
        tabIndex={disabled ? -1 : 0}
        id={fieldId}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-describedby={ariaDescribedBy}
        aria-invalid={invalid || undefined}
        aria-required={required || undefined}
        aria-disabled={disabled || undefined}
        onClick={(event: ReactMouseEvent<HTMLDivElement>) => {
          if (disabled) return;
          if ((event.target as HTMLElement).closest("button")) return;
          setOpen(!open);
        }}
        onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => {
          if (disabled) return;
          if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className={cx(
          shellClass(size, invalid, disabled),
          SIZE_H[size],
          SIZE_PX[size],
          "cursor-pointer text-left",
        )}
      >
        <IconCalendar size={SIZE_ICON[size]} className="mr-1.5 shrink-0 text-content-subtle" />
        <span
          className={cx(
            "min-w-0 flex-1 truncate",
            label ? "text-content" : "text-content-subtle",
          )}
        >
          {label ?? placeholder}
        </span>
        {spanDays !== null ? (
          <span className="ml-1.5 shrink-0 text-meta tabular-nums text-content-subtle">
            {spanDays}d
          </span>
        ) : null}
        {clearable && range?.from && !disabled ? (
          <ClearButton onClear={() => commit(null, false)} label="Clear range" className="ml-1" />
        ) : null}
        <FieldChevron open={open} px={SIZE_ICON[size]} />
      </div>

      {name ? (
        <>
          <input
            type="hidden"
            name={`${name}From`}
            value={range?.from ? formatDate(range.from, "yyyy-MM-dd") : ""}
          />
          <input
            type="hidden"
            name={`${name}To`}
            value={range?.to ? formatDate(range.to, "yyyy-MM-dd") : ""}
          />
        </>
      ) : null}

      <AnchoredPanel
        open={open}
        onOpenChange={setOpen}
        anchor={anchor}
        trapFocus
        role="dialog"
        id={panelId}
        ariaLabel={ariaLabel ?? "Choose a date range"}
        maxHeight={540}
      >
        <div className="flex min-h-0 flex-1">
          {rows.length > 0 ? (
            <div className="w-40 shrink-0 overflow-y-auto border-r border-border-subtle p-1.5">
              {rows.map((preset) => (
                <button
                  key={preset.key}
                  type="button"
                  onClick={() => {
                    const next = preset.range();
                    if (next.from) setMonth(next.from);
                    commit(next, true);
                  }}
                  className={cx(
                    "flex w-full items-center rounded-md px-2 py-1.5 text-left text-body",
                    "transition-colors hover:bg-surface-hover",
                    activePreset === preset.key
                      ? "bg-accent-subtle font-medium text-accent-subtle-fg"
                      : "text-content",
                  )}
                >
                  <span className="truncate">{preset.label}</span>
                </button>
              ))}
              <div className="mt-1 border-t border-border-subtle pt-1">
                <span
                  className={cx(
                    "flex w-full items-center rounded-md px-2 py-1.5 text-left text-body",
                    activePreset === "custom"
                      ? "bg-accent-subtle font-medium text-accent-subtle-fg"
                      : "text-content-subtle",
                  )}
                >
                  Custom
                </span>
              </div>
            </div>
          ) : null}

          <div className="min-w-0 flex-1 overflow-y-auto p-3">
            <Calendar
              mode="range"
              selected={
                range?.from
                  ? { from: range.from, to: range.to ?? undefined }
                  : undefined
              }
              onSelect={(next) =>
                commit(
                  next?.from ? { from: next.from, to: next.to ?? null } : null,
                  false,
                )
              }
              month={month}
              onMonthChange={setMonth}
              startMonth={min}
              endMonth={max}
              disabled={disabledMatchers}
              max={maxDays}
              excludeDisabled
              weekStartsOn={weekStartsOn}
              numberOfMonths={numberOfMonths}
              showOutsideDays
              autoFocus
            />
            <div className="mt-3 flex items-center justify-between gap-2 border-t border-border-subtle pt-2.5">
              <span className="text-meta text-content-subtle">
                {range?.from && range.to
                  ? `${formatDate(range.from, "d MMM yyyy")} → ${formatDate(range.to, "d MMM yyyy")}`
                  : range?.from
                    ? "Pick the end date"
                    : "Pick the start date"}
              </span>
              <span className="flex items-center gap-2">
                <Button size="sm" variant="ghost" onClick={() => commit(null, false)}>
                  Reset
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setOpen(false)}>
                  Done
                </Button>
              </span>
            </div>
            {footer ? (
              <div className="mt-2 border-t border-border-subtle pt-2">{footer}</div>
            ) : null}
          </div>
        </div>
      </AnchoredPanel>
    </div>
  );
}

/* ==========================================================================
   TimePicker
   ========================================================================== */

function minutesFromHHmm(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function hhmmFromMinutes(total: number): string {
  const wrapped = ((total % 1440) + 1440) % 1440;
  const hours = Math.floor(wrapped / 60);
  const minutes = wrapped % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/**
 * Parse loose time entry into canonical `"HH:mm"`:
 * `9`, `930`, `9:30`, `9.30`, `9 30`, `9p`, `9:30 pm`, `0930`, `17:45`.
 */
export function parseTimeInput(text: string): string | null {
  const raw = text.trim().toLowerCase().replace(/\s+/g, "");
  if (!raw) return null;

  const meridiem = /(am|pm|a|p)$/.exec(raw);
  const body = meridiem ? raw.slice(0, raw.length - (meridiem[1] ?? "").length) : raw;
  const digits = body.replace(/[^0-9]/g, "");
  if (!digits) return null;

  let hours: number;
  let minutes: number;
  if (/[:.]/.test(body)) {
    const [left = "", right = ""] = body.split(/[:.]/);
    hours = Number(left);
    minutes = right === "" ? 0 : Number(right.padEnd(2, "0").slice(0, 2));
  } else if (digits.length <= 2) {
    hours = Number(digits);
    minutes = 0;
  } else if (digits.length === 3) {
    hours = Number(digits.slice(0, 1));
    minutes = Number(digits.slice(1));
  } else {
    hours = Number(digits.slice(0, 2));
    minutes = Number(digits.slice(2, 4));
  }

  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  if (minutes > 59) return null;

  const suffix = meridiem?.[1];
  if (suffix === "pm" || suffix === "p") {
    if (hours < 12) hours += 12;
  } else if (suffix === "am" || suffix === "a") {
    if (hours === 12) hours = 0;
  }
  if (hours > 23) return null;
  return hhmmFromMinutes(hours * 60 + minutes);
}

/** `"13:30"` → `"1:30 PM"` (or `"13:30"` when `use12Hour` is false). */
export function formatTimeLabel(value: string, use12Hour = false): string {
  const total = minutesFromHHmm(value);
  if (total === null) return value;
  if (!use12Hour) return hhmmFromMinutes(total);
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  const suffix = hours >= 12 ? "PM" : "AM";
  const display = hours % 12 === 0 ? 12 : hours % 12;
  return `${display}:${String(minutes).padStart(2, "0")} ${suffix}`;
}

export interface TimePickerProps {
  /** Canonical 24-hour `"HH:mm"`. Display can still be 12-hour. */
  value?: string | null;
  defaultValue?: string | null;
  onChange?: (value: string | null) => void;
  /** Minutes between generated options. Default 15. */
  step?: number;
  /** Inclusive bounds, `"HH:mm"`. */
  min?: string;
  max?: string;
  /** Render options and the field as 12-hour. Default `false`. */
  use12Hour?: boolean;
  placeholder?: string;
  clearable?: boolean;
  size?: InputSize;
  disabled?: boolean;
  invalid?: boolean;
  required?: boolean;
  name?: string;
  id?: string;
  className?: string;
  maxPanelHeight?: number;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  onBlur?: () => void;
}

/**
 * Time field with a typed fast path and a scrolling option list.
 *
 *   <TimePicker value={startAt} onChange={setStartAt} step={30} />
 */
export function TimePicker({
  value,
  defaultValue = null,
  onChange,
  step = 15,
  min,
  max,
  use12Hour = false,
  placeholder = "--:--",
  clearable = true,
  size = "md",
  disabled = false,
  invalid = false,
  required = false,
  name,
  id,
  className,
  maxPanelHeight = 260,
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  "aria-describedby": ariaDescribedBy,
  onBlur,
}: TimePickerProps) {
  const fieldId = useIsomorphicId(id);
  const listId = `${fieldId}-times`;
  const [open, setOpen] = useControllableState(controlledOpen, defaultOpen, onOpenChange);
  const [selected, setSelected] = useControllableState<string | null>(
    value,
    defaultValue,
    undefined,
  );
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rowRefs = useRef(new Map<number, HTMLElement>());
  const emitChange = useEvent(onChange);

  const slots = useMemo(() => {
    const safeStep = Math.max(1, Math.round(step));
    const start = minutesFromHHmm(min) ?? 0;
    const end = minutesFromHHmm(max) ?? 1439;
    const list: string[] = [];
    for (let m = start; m <= end; m += safeStep) list.push(hhmmFromMinutes(m));
    return list;
  }, [max, min, step]);

  const commit = useCallback(
    (next: string | null, closePanel = true) => {
      setSelected(next);
      emitChange(next);
      if (closePanel) setOpen(false);
    },
    [emitChange, setOpen, setSelected],
  );

  useEffect(() => {
    if (!open) return;
    const target = selected ?? slots[0] ?? null;
    const index = target ? slots.indexOf(target) : -1;
    setActiveIndex(index >= 0 ? index : 0);
  }, [open, selected, slots]);

  useEffect(() => {
    if (!open) return;
    const node = rowRefs.current.get(activeIndex);
    node?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  const commitTyped = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed) {
      if (selected) commit(null, false);
      return;
    }
    const parsed = parseTimeInput(trimmed);
    if (!parsed) {
      setText(selected ? formatTimeLabel(selected, use12Hour) : "");
      return;
    }
    const minutes = minutesFromHHmm(parsed) ?? 0;
    const low = minutesFromHHmm(min);
    const high = minutesFromHHmm(max);
    const clamped =
      low !== null && minutes < low
        ? hhmmFromMinutes(low)
        : high !== null && minutes > high
          ? hhmmFromMinutes(high)
          : parsed;
    commit(clamped, false);
  }, [commit, max, min, selected, text, use12Hour]);

  const display = focused
    ? text
    : selected
      ? formatTimeLabel(selected, use12Hour)
      : "";

  return (
    <div className={cx("relative w-full", className)} data-slot="time-picker">
      <div
        ref={setAnchor}
        className={cx(shellClass(size, invalid, disabled), SIZE_H[size], SIZE_PX[size])}
        onMouseDown={(event: ReactMouseEvent<HTMLDivElement>) => {
          if (disabled) return;
          if ((event.target as HTMLElement).closest("button")) return;
          if (!open) setOpen(true);
        }}
      >
        <IconClock size={SIZE_ICON[size]} className="mr-1.5 shrink-0 text-content-subtle" />
        <input
          ref={inputRef}
          id={fieldId}
          type="text"
          role="combobox"
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          required={required}
          value={display}
          placeholder={placeholder}
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={open && slots[activeIndex] ? `${listId}-t${activeIndex}` : undefined}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          aria-describedby={ariaDescribedBy}
          aria-invalid={invalid || undefined}
          onFocus={() => {
            setFocused(true);
            setText(selected ? formatTimeLabel(selected, use12Hour) : "");
          }}
          onBlur={() => {
            setFocused(false);
            commitTyped();
            onBlur?.();
          }}
          onChange={(event) => {
            setText(event.target.value);
            if (!open) setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              if (!open) setOpen(true);
              else setActiveIndex((index) => Math.min(slots.length - 1, index + 1));
              return;
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              if (!open) setOpen(true);
              else setActiveIndex((index) => Math.max(0, index - 1));
              return;
            }
            if (event.key === "Enter") {
              event.preventDefault();
              const slot = slots[activeIndex];
              /* Typed entry wins; otherwise take whatever row is highlighted. */
              if (text.trim() && parseTimeInput(text)) {
                commitTyped();
                setOpen(false);
              } else if (open && slot) {
                commit(slot);
              } else {
                commitTyped();
                setOpen(false);
              }
              return;
            }
            if (event.key === "Tab" && open) setOpen(false);
          }}
          className={cx(BARE_INPUT, "tabular-nums")}
        />
        {clearable && selected && !disabled ? (
          <ClearButton onClear={() => commit(null, false)} label="Clear time" className="ml-1" />
        ) : null}
        <button
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          disabled={disabled}
          onMouseDown={(event) => {
            event.preventDefault();
            if (!disabled) setOpen(!open);
          }}
          className="ml-1 grid size-5 shrink-0 place-items-center rounded text-content-subtle hover:text-content"
        >
          <FieldChevron open={open} px={SIZE_ICON[size]} />
        </button>
      </div>

      {name ? <input type="hidden" name={name} value={selected ?? ""} /> : null}

      <AnchoredPanel
        open={open}
        onOpenChange={setOpen}
        anchor={anchor}
        matchAnchorWidth
        maxHeight={maxPanelHeight}
        id={listId}
        role="listbox"
        ariaLabel={ariaLabel ?? "Times"}
      >
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5">
          {slots.length === 0 ? (
            <PanelMessage icon={IconClock}>No times available</PanelMessage>
          ) : null}
          {slots.map((slot, index) => {
            const isSelected = slot === selected;
            return (
              <div
                key={slot}
                ref={(node) => {
                  if (node) rowRefs.current.set(index, node);
                  else rowRefs.current.delete(index);
                }}
                id={`${listId}-t${index}`}
                role="option"
                aria-selected={isSelected}
                data-active={index === activeIndex}
                onMouseEnter={() => setActiveIndex(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => commit(slot)}
                className={cx(OPTION_ROW, "justify-between tabular-nums")}
              >
                <span>{formatTimeLabel(slot, use12Hour)}</span>
                {isSelected ? <IconCheck size={14} className="text-accent-text" /> : null}
              </div>
            );
          })}
        </div>
      </AnchoredPanel>
    </div>
  );
}

/* ==========================================================================
   DateTimePicker
   ========================================================================== */

export interface DateTimePickerProps
  extends Omit<
    DatePickerProps,
    "value" | "defaultValue" | "onChange" | "name" | "format" | "className"
  > {
  value?: Date | null;
  defaultValue?: Date | null;
  onChange?: (value: Date | null) => void;
  /** date-fns pattern for the date half. Default `"d MMM yyyy"`. */
  dateFormat?: string;
  /** Minutes between time options. Default 15. */
  timeStep?: number;
  use12Hour?: boolean;
  /** Time used when a date is picked but no time is set yet. Default `"09:00"`. */
  defaultTime?: string;
  timePlaceholder?: string;
  name?: string;
  className?: string;
}

/**
 * A date field and a time field bound to one `Date`.
 *
 *   <DateTimePicker value={startsAt} onChange={setStartsAt} timeStep={30} />
 */
export function DateTimePicker({
  value,
  defaultValue = null,
  onChange,
  dateFormat = "d MMM yyyy",
  timeStep = 15,
  use12Hour = false,
  defaultTime = "09:00",
  timePlaceholder = "--:--",
  name,
  className,
  size = "md",
  disabled,
  invalid,
  required,
  id,
  ...dateProps
}: DateTimePickerProps) {
  const fieldId = useIsomorphicId(id);
  const [current, setCurrent] = useControllableState<Date | null>(
    value,
    defaultValue,
    undefined,
  );
  const emitChange = useEvent(onChange);

  const timeValue = current
    ? hhmmFromMinutes(current.getHours() * 60 + current.getMinutes())
    : null;

  const commit = useCallback(
    (next: Date | null) => {
      setCurrent(next);
      emitChange(next);
    },
    [emitChange, setCurrent],
  );

  return (
    <div
      className={cx("flex w-full items-start gap-2", className)}
      data-slot="date-time-picker"
    >
      <div className="min-w-0 flex-[3]">
        <DatePicker
          {...dateProps}
          id={`${fieldId}-date`}
          size={size}
          disabled={disabled}
          invalid={invalid}
          required={required}
          format={dateFormat}
          value={current}
          onChange={(date) => {
            if (!date) {
              commit(null);
              return;
            }
            const minutes = minutesFromHHmm(timeValue ?? defaultTime) ?? 0;
            const next = new Date(date);
            next.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
            commit(next);
          }}
        />
      </div>
      <div className="w-32 shrink-0">
        <TimePicker
          id={`${fieldId}-time`}
          size={size}
          disabled={disabled}
          invalid={invalid}
          step={timeStep}
          use12Hour={use12Hour}
          placeholder={timePlaceholder}
          value={timeValue}
          aria-label="Time"
          onChange={(time) => {
            if (!current) {
              if (!time) return;
              const minutes = minutesFromHHmm(time) ?? 0;
              const next = startOfDay(new Date());
              next.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
              commit(next);
              return;
            }
            const minutes = minutesFromHHmm(time ?? defaultTime) ?? 0;
            const next = new Date(current);
            next.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
            commit(next);
          }}
        />
      </div>
      {name ? (
        <input type="hidden" name={name} value={current ? current.toISOString() : ""} />
      ) : null}
    </div>
  );
}

/* ==========================================================================
   Numeric helpers — integer-exact, never a float round-trip
   ========================================================================== */

function localeSeparators(locale?: string): { decimal: string; group: string } {
  try {
    const parts = new Intl.NumberFormat(locale).formatToParts(12345.6);
    const decimal = parts.find((part) => part.type === "decimal")?.value ?? ".";
    const group = parts.find((part) => part.type === "group")?.value ?? ",";
    return { decimal, group };
  } catch {
    return { decimal: ".", group: "," };
  }
}

/** Round half-away-from-zero at `dp` decimal places, EPSILON-corrected. */
function roundTo(value: number, dp: number): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** Math.max(0, Math.min(15, dp));
  const scaled = value * factor;
  const rounded =
    scaled >= 0
      ? Math.round(scaled + Number.EPSILON * Math.abs(scaled))
      : -Math.round(-scaled + Number.EPSILON * Math.abs(scaled));
  return rounded / factor;
}

function groupDigits(digits: string, separator: string): string {
  if (!separator) return digits;
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, separator);
}

/**
 * Split a typed number into an exact `{ sign, int, frac }` digit triple.
 * Grouping separators are dropped; the *last* decimal separator wins.
 */
function splitNumericText(
  text: string,
  locale?: string,
): { negative: boolean; int: string; frac: string } | null {
  const raw = text.trim();
  if (!raw) return null;
  const { decimal } = localeSeparators(locale);
  const negative = /^\(.*\)$/.test(raw) || raw.trimStart().startsWith("-");

  /* Keep digits and both separator candidates, then decide which is decimal. */
  const kept = raw.replace(/[^0-9.,٫٬]/g, "");
  if (!kept) return null;

  const decimalChar = decimal === "," ? "," : ".";
  const groupChar = decimalChar === "," ? "." : ",";
  const withoutGroups = kept.split(groupChar).join("");
  const pieces = withoutGroups.split(decimalChar);
  const first = pieces.shift() ?? "";
  const int = first.replace(/\D/g, "");
  const frac = pieces.join("").replace(/\D/g, "");
  if (!int && !frac) return null;
  return { negative, int: int || "0", frac };
}

/** The number of minor units in one major unit for `currency` (USD 2, JPY 0). */
export function currencyExponent(currency: string, locale?: string): number {
  try {
    const resolved = new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
    }).resolvedOptions();
    return resolved.maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/**
 * Parse typed money into MINOR units with integer arithmetic — no float ever
 * touches the value, so `"1,234.56"` is exactly `123456`, not `123455.99999`.
 */
export function parseCurrencyToMinor(
  text: string,
  exponent: number,
  locale?: string,
): number | null {
  const split = splitNumericText(text, locale);
  if (!split) return null;
  const digits = Math.max(0, Math.min(6, Math.trunc(exponent)));

  let minor: bigint;
  if (split.frac.length <= digits) {
    minor = BigInt(split.int + split.frac.padEnd(digits, "0"));
  } else {
    const keep = split.frac.slice(0, digits);
    const nextDigit = split.frac.charCodeAt(digits) - 48;
    minor = BigInt(split.int + keep);
    if (nextDigit >= 5) minor += 1n;
  }
  if (split.negative) minor = -minor;

  if (minor > BigInt(Number.MAX_SAFE_INTEGER) || minor < BigInt(-Number.MAX_SAFE_INTEGER)) {
    return null;
  }
  return Number(minor);
}

/** Minor units → a plain decimal string (no symbol). `12345, 2` → `"123.45"`. */
export function formatMinorUnits(
  minor: number,
  exponent: number,
  options: { locale?: string; grouping?: boolean } = {},
): string {
  const digits = Math.max(0, Math.min(6, Math.trunc(exponent)));
  const { decimal, group } = localeSeparators(options.locale);
  const negative = minor < 0;
  const absolute = Math.abs(Math.trunc(minor)).toString().padStart(digits + 1, "0");
  const int = absolute.slice(0, absolute.length - digits) || "0";
  const frac = digits > 0 ? absolute.slice(absolute.length - digits) : "";
  const grouped = options.grouping === false ? int : groupDigits(int, group);
  return `${negative ? "-" : ""}${grouped}${digits > 0 ? decimal + frac : ""}`;
}

/** Minor units → a fully localised currency string. `12345, "USD"` → `"$123.45"`. */
export function formatCurrencyMinor(
  minor: number,
  currency = "USD",
  locale?: string,
  options: { compact?: boolean; showSymbol?: boolean } = {},
): string {
  const exponent = currencyExponent(currency, locale);
  const major = minor / 10 ** exponent;
  try {
    return new Intl.NumberFormat(locale, {
      style: options.showSymbol === false ? "decimal" : "currency",
      currency,
      currencyDisplay: "narrowSymbol",
      notation: options.compact ? "compact" : "standard",
      minimumFractionDigits: options.compact ? 0 : exponent,
      maximumFractionDigits: exponent,
    }).format(major);
  } catch {
    return `${currency} ${formatMinorUnits(minor, exponent, { locale })}`;
  }
}

/* ==========================================================================
   NumberInput
   ========================================================================== */

function Stepper({
  onStep,
  disabled,
  compact,
}: {
  onStep: (direction: 1 | -1) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const base =
    "flex flex-1 items-center justify-center text-content-subtle transition-colors " +
    "hover:bg-surface-hover hover:text-content active:bg-surface-active " +
    "disabled:pointer-events-none disabled:opacity-40";
  return (
    <span
      className={cx(
        "-mr-1.5 ml-1 flex h-full shrink-0 flex-col self-stretch overflow-hidden",
        "border-l border-border-subtle",
        compact ? "w-4" : "w-5",
      )}
      aria-hidden="true"
    >
      <button
        type="button"
        tabIndex={-1}
        disabled={disabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onStep(1)}
        className={cx(base, "border-b border-border-subtle")}
      >
        <IconChevronDown size={11} strokeWidth={2.5} className="rotate-180" />
      </button>
      <button
        type="button"
        tabIndex={-1}
        disabled={disabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onStep(-1)}
        className={base}
      >
        <IconChevronDown size={11} strokeWidth={2.5} />
      </button>
    </span>
  );
}

export interface NumberInputProps {
  value?: number | null;
  defaultValue?: number | null;
  onChange?: (value: number | null) => void;
  min?: number;
  max?: number;
  /** Arrow-key / stepper increment. Default 1. */
  step?: number;
  /** Decimal places kept on commit. Default 0. */
  precision?: number;
  /** Allow a leading minus. Defaults to `true` unless `min >= 0`. */
  allowNegative?: boolean;
  /** Clamp into [min, max] on blur. Default `true`. */
  clampOnBlur?: boolean;
  /** Thousands separators while not focused. Default `true`. */
  grouping?: boolean;
  locale?: string;
  placeholder?: string;
  /** Leading adornment (unit, symbol, icon). */
  prefix?: ReactNode;
  /** Trailing adornment. */
  suffix?: ReactNode;
  /** Show the up/down stepper. Default `true`. */
  showStepper?: boolean;
  align?: "left" | "right";
  size?: InputSize;
  disabled?: boolean;
  invalid?: boolean;
  required?: boolean;
  readOnly?: boolean;
  name?: string;
  id?: string;
  className?: string;
  inputClassName?: string;
  autoFocus?: boolean;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  onFocus?: () => void;
  onBlur?: () => void;
}

/**
 * Numeric field with a stepper, bounds, and a fixed precision.
 *
 *   <NumberInput value={qty} onChange={setQty} min={0} step={1} suffix="ea" />
 */
export const NumberInput = forwardRef<HTMLInputElement, NumberInputProps>(
  function NumberInput(
    {
      value,
      defaultValue = null,
      onChange,
      min,
      max,
      step = 1,
      precision = 0,
      allowNegative,
      clampOnBlur = true,
      grouping = true,
      locale,
      placeholder,
      prefix,
      suffix,
      showStepper = true,
      align = "right",
      size = "md",
      disabled = false,
      invalid = false,
      required = false,
      readOnly = false,
      name,
      id,
      className,
      inputClassName,
      autoFocus,
      "aria-label": ariaLabel,
      "aria-labelledby": ariaLabelledBy,
      "aria-describedby": ariaDescribedBy,
      onFocus,
      onBlur,
    },
    ref,
  ) {
    const [current, setCurrent] = useControllableState<number | null>(
      value,
      defaultValue,
      undefined,
    );
    const [text, setText] = useState("");
    const [focused, setFocused] = useState(false);
    const innerRef = useRef<HTMLInputElement | null>(null);
    const emitChange = useEvent(onChange);
    const negativeAllowed = allowNegative ?? !(typeof min === "number" && min >= 0);

    useImperativeHandle(ref, () => innerRef.current as HTMLInputElement, []);

    const clamp = useCallback(
      (n: number) => {
        let next = n;
        if (typeof min === "number" && next < min) next = min;
        if (typeof max === "number" && next > max) next = max;
        return roundTo(next, precision);
      },
      [max, min, precision],
    );

    const commit = useCallback(
      (next: number | null) => {
        setCurrent(next);
        emitChange(next);
      },
      [emitChange, setCurrent],
    );

    const parse = useCallback(
      (input: string): number | null => {
        const split = splitNumericText(input, locale);
        if (!split) return null;
        const raw = Number(`${split.int}.${split.frac || "0"}`);
        if (!Number.isFinite(raw)) return null;
        const signed = split.negative && negativeAllowed ? -raw : raw;
        return roundTo(signed, precision);
      },
      [locale, negativeAllowed, precision],
    );

    const formatted = useMemo(() => {
      if (current === null) return "";
      try {
        return new Intl.NumberFormat(locale, {
          minimumFractionDigits: precision,
          maximumFractionDigits: precision,
          useGrouping: grouping,
        }).format(current);
      } catch {
        return current.toFixed(precision);
      }
    }, [current, grouping, locale, precision]);

    const stepBy = useCallback(
      (direction: 1 | -1, multiplier = 1) => {
        if (disabled || readOnly) return;
        const base = current ?? (typeof min === "number" ? min : 0);
        const next = clamp(base + direction * step * multiplier);
        commit(next);
        setText(
          new Intl.NumberFormat(locale, {
            minimumFractionDigits: 0,
            maximumFractionDigits: precision,
            useGrouping: false,
          }).format(next),
        );
      },
      [clamp, commit, current, disabled, locale, min, precision, readOnly, step],
    );

    const display = focused ? text : formatted;

    return (
      <div
        className={cx(
          shellClass(size, invalid, disabled),
          SIZE_H[size],
          SIZE_PX[size],
          className,
        )}
        data-slot="number-input"
      >
        {prefix !== undefined ? (
          <span className="mr-1.5 flex shrink-0 items-center text-meta text-content-subtle">
            {prefix}
          </span>
        ) : null}
        <input
          ref={innerRef}
          id={id}
          name={name}
          type="text"
          inputMode={precision > 0 ? "decimal" : "numeric"}
          autoComplete="off"
          spellCheck={false}
          autoFocus={autoFocus}
          disabled={disabled}
          readOnly={readOnly}
          required={required}
          value={display}
          placeholder={placeholder}
          role="spinbutton"
          aria-valuenow={current ?? undefined}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuetext={current === null ? "Empty" : formatted}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          aria-describedby={ariaDescribedBy}
          aria-invalid={invalid || undefined}
          onFocus={() => {
            setFocused(true);
            setText(
              current === null
                ? ""
                : new Intl.NumberFormat(locale, {
                    minimumFractionDigits: 0,
                    maximumFractionDigits: precision,
                    useGrouping: false,
                  }).format(current),
            );
            onFocus?.();
          }}
          onBlur={() => {
            setFocused(false);
            const parsed = parse(text);
            if (parsed === null) commit(null);
            else commit(clampOnBlur ? clamp(parsed) : roundTo(parsed, precision));
            onBlur?.();
          }}
          onChange={(event) => {
            const next = event.target.value;
            setText(next);
            const parsed = parse(next);
            if (parsed !== null) commit(parsed);
            else if (next.trim() === "") commit(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowUp") {
              event.preventDefault();
              stepBy(1, event.shiftKey ? 10 : 1);
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              stepBy(-1, event.shiftKey ? 10 : 1);
            } else if (event.key === "PageUp") {
              event.preventDefault();
              stepBy(1, 10);
            } else if (event.key === "PageDown") {
              event.preventDefault();
              stepBy(-1, 10);
            } else if (event.key === "Home" && typeof min === "number") {
              event.preventDefault();
              commit(clamp(min));
              setText(String(min));
            } else if (event.key === "End" && typeof max === "number") {
              event.preventDefault();
              commit(clamp(max));
              setText(String(max));
            }
          }}
          className={cx(
            BARE_INPUT,
            "tabular-nums",
            align === "right" ? "text-right" : "text-left",
            inputClassName,
          )}
        />
        {suffix !== undefined ? (
          <span className="ml-1.5 flex shrink-0 items-center text-meta text-content-subtle">
            {suffix}
          </span>
        ) : null}
        {showStepper && !readOnly ? (
          <Stepper
            onStep={(direction) => {
              stepBy(direction);
              innerRef.current?.focus();
            }}
            disabled={disabled}
            compact={size === "xs" || size === "sm"}
          />
        ) : null}
      </div>
    );
  },
);

/* ==========================================================================
   CurrencyInput
   ========================================================================== */

export interface CurrencyInputProps {
  /**
   * The amount in MINOR units (cents, pence, fils). This is the canonical
   * value and the only thing that crosses the wire — never a float major.
   */
  value?: number | null;
  defaultValue?: number | null;
  onChange?: (
    minorUnits: number | null,
    meta: { major: number | null; currency: string; exponent: number },
  ) => void;
  /** ISO 4217 code. Drives the symbol *and* the number of minor digits. */
  currency?: string;
  locale?: string;
  /** Override the currency's natural exponent (rare — e.g. 4dp unit rates). */
  exponent?: number;
  /** Bounds, in MINOR units. */
  min?: number;
  max?: number;
  allowNegative?: boolean;
  /** Show the currency symbol as a leading adornment. Default `true`. */
  showSymbol?: boolean;
  /** Show the ISO code on the right edge. Default `false`. */
  showCode?: boolean;
  placeholder?: string;
  size?: InputSize;
  disabled?: boolean;
  invalid?: boolean;
  required?: boolean;
  readOnly?: boolean;
  name?: string;
  id?: string;
  className?: string;
  autoFocus?: boolean;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  onFocus?: () => void;
  onBlur?: () => void;
}

/**
 * Money entry that stores minor units and never loses a cent.
 *
 *   <CurrencyInput value={amountCents} currency="USD"
 *                  onChange={(minor) => setAmountCents(minor)} />
 */
export const CurrencyInput = forwardRef<HTMLInputElement, CurrencyInputProps>(
  function CurrencyInput(
    {
      value,
      defaultValue = null,
      onChange,
      currency = "USD",
      locale,
      exponent,
      min,
      max,
      allowNegative = false,
      showSymbol = true,
      showCode = false,
      placeholder,
      size = "md",
      disabled = false,
      invalid = false,
      required = false,
      readOnly = false,
      name,
      id,
      className,
      autoFocus,
      "aria-label": ariaLabel,
      "aria-labelledby": ariaLabelledBy,
      "aria-describedby": ariaDescribedBy,
      onFocus,
      onBlur,
    },
    ref,
  ) {
    const [minorValue, setMinorValue] = useControllableState<number | null>(
      value,
      defaultValue,
      undefined,
    );
    const [text, setText] = useState("");
    const [focused, setFocused] = useState(false);
    const innerRef = useRef<HTMLInputElement | null>(null);
    const emitChange = useEvent(onChange);
    const digits = exponent ?? currencyExponent(currency, locale);

    useImperativeHandle(ref, () => innerRef.current as HTMLInputElement, []);

    const symbol = useMemo(() => {
      try {
        const parts = new Intl.NumberFormat(locale, {
          style: "currency",
          currency,
          currencyDisplay: "narrowSymbol",
        }).formatToParts(0);
        return parts.find((part) => part.type === "currency")?.value ?? currency;
      } catch {
        return currency;
      }
    }, [currency, locale]);

    const commit = useCallback(
      (minor: number | null) => {
        let next = minor;
        if (next !== null) {
          if (!allowNegative && next < 0) next = Math.abs(next);
          if (typeof min === "number" && next < min) next = min;
          if (typeof max === "number" && next > max) next = max;
        }
        setMinorValue(next);
        emitChange(next, {
          major: next === null ? null : next / 10 ** digits,
          currency,
          exponent: digits,
        });
      },
      [allowNegative, currency, digits, emitChange, max, min, setMinorValue],
    );

    const blurredDisplay =
      minorValue === null
        ? ""
        : formatCurrencyMinor(minorValue, currency, locale, { showSymbol: false });
    const display = focused ? text : blurredDisplay;

    return (
      <div
        className={cx(
          shellClass(size, invalid, disabled),
          SIZE_H[size],
          SIZE_PX[size],
          className,
        )}
        data-slot="currency-input"
      >
        {showSymbol ? (
          <span className="mr-1.5 shrink-0 select-none text-content-subtle">{symbol}</span>
        ) : null}
        <input
          ref={innerRef}
          id={id}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          autoFocus={autoFocus}
          disabled={disabled}
          readOnly={readOnly}
          required={required}
          value={display}
          placeholder={placeholder ?? (digits > 0 ? `0${localeSeparators(locale).decimal}${"0".repeat(digits)}` : "0")}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          aria-describedby={ariaDescribedBy}
          aria-invalid={invalid || undefined}
          onFocus={() => {
            setFocused(true);
            setText(
              minorValue === null
                ? ""
                : formatMinorUnits(minorValue, digits, { locale, grouping: false }),
            );
            onFocus?.();
          }}
          onBlur={() => {
            setFocused(false);
            commit(parseCurrencyToMinor(text, digits, locale));
            onBlur?.();
          }}
          onChange={(event) => {
            const next = event.target.value;
            setText(next);
            if (next.trim() === "") commit(null);
            else {
              const parsed = parseCurrencyToMinor(next, digits, locale);
              if (parsed !== null) commit(parsed);
            }
          }}
          onKeyDown={(event) => {
            if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
            event.preventDefault();
            const unit = 10 ** digits;
            const magnitude = event.shiftKey ? unit * 10 : unit;
            const base = minorValue ?? 0;
            commit(base + (event.key === "ArrowUp" ? magnitude : -magnitude));
            setText(
              formatMinorUnits(base + (event.key === "ArrowUp" ? magnitude : -magnitude), digits, {
                locale,
                grouping: false,
              }),
            );
          }}
          className={cx(BARE_INPUT, "text-right tabular-nums")}
        />
        {showCode ? (
          <span className="ml-1.5 shrink-0 select-none font-mono text-meta text-content-subtle">
            {currency}
          </span>
        ) : null}
        {name ? <input type="hidden" name={name} value={minorValue ?? ""} /> : null}
      </div>
    );
  },
);

/* ==========================================================================
   PercentInput
   ========================================================================== */

export interface PercentInputProps {
  /**
   * In `"percent"` mode (default) `12.5` means 12.5%.
   * In `"fraction"` mode `0.125` means 12.5%.
   */
  value?: number | null;
  defaultValue?: number | null;
  onChange?: (value: number | null) => void;
  mode?: "percent" | "fraction";
  /** Decimal places kept on the *displayed* percentage. Default 2. */
  precision?: number;
  /** Bounds expressed in the same unit as `value`. Defaults to 0–100 / 0–1. */
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  size?: InputSize;
  disabled?: boolean;
  invalid?: boolean;
  required?: boolean;
  readOnly?: boolean;
  showStepper?: boolean;
  name?: string;
  id?: string;
  className?: string;
  autoFocus?: boolean;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  onBlur?: () => void;
}

/**
 * Percentage entry. Works in whole percents or in 0–1 fractions, and rounds
 * the stored value so `33.33%` never becomes `0.33329999999999996`.
 */
export function PercentInput({
  value,
  defaultValue = null,
  onChange,
  mode = "percent",
  precision = 2,
  min,
  max,
  step = 1,
  placeholder = "0",
  size = "md",
  disabled,
  invalid,
  required,
  readOnly,
  showStepper = true,
  name,
  id,
  className,
  autoFocus,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  "aria-describedby": ariaDescribedBy,
  onBlur,
}: PercentInputProps) {
  const scale = mode === "fraction" ? 100 : 1;
  const toDisplay = (raw: number | null) =>
    raw === null ? null : roundTo(raw * scale, precision);
  const toStored = (display: number | null) =>
    display === null ? null : roundTo(display / scale, precision + (mode === "fraction" ? 2 : 0));

  const emitChange = useEvent(onChange);
  const displayMin = typeof min === "number" ? min * scale : 0;
  const displayMax = typeof max === "number" ? max * scale : 100;

  return (
    <NumberInput
      value={value === undefined ? undefined : toDisplay(value)}
      defaultValue={toDisplay(defaultValue)}
      onChange={(next) => emitChange(toStored(next))}
      min={displayMin}
      max={displayMax}
      step={step}
      precision={precision}
      allowNegative={displayMin < 0}
      suffix="%"
      align="right"
      size={size}
      disabled={disabled}
      invalid={invalid}
      required={required}
      readOnly={readOnly}
      showStepper={showStepper}
      name={name}
      id={id}
      className={className}
      autoFocus={autoFocus}
      placeholder={placeholder}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-describedby={ariaDescribedBy}
      onBlur={onBlur}
    />
  );
}

/* ==========================================================================
   DurationInput
   ========================================================================== */

export type DurationUnit = "w" | "d" | "h" | "m";

const DURATION_ALIASES: Record<string, DurationUnit> = {
  w: "w",
  wk: "w",
  wks: "w",
  week: "w",
  weeks: "w",
  d: "d",
  day: "d",
  days: "d",
  h: "h",
  hr: "h",
  hrs: "h",
  hour: "h",
  hours: "h",
  m: "m",
  min: "m",
  mins: "m",
  minute: "m",
  minutes: "m",
};

function unitMinutes(
  unit: DurationUnit,
  hoursPerDay: number,
  daysPerWeek: number,
): number {
  if (unit === "m") return 1;
  if (unit === "h") return 60;
  if (unit === "d") return hoursPerDay * 60;
  return daysPerWeek * hoursPerDay * 60;
}

export interface DurationOptions {
  /** Working hours in a day. Default 8. */
  hoursPerDay?: number;
  /** Working days in a week. Default 5. */
  daysPerWeek?: number;
  /** Units offered, largest first. Default `["d", "h"]`. */
  units?: readonly DurationUnit[];
  /** Unit assumed for a bare number. Default `"h"`. */
  defaultUnit?: DurationUnit;
}

/**
 * Parse `"2d 4h"`, `"3.5d"`, `"90m"`, `"1w2d"`, `"2:30"` into MINUTES.
 * Returns `null` when nothing numeric can be read.
 */
export function parseDuration(text: string, options: DurationOptions = {}): number | null {
  const hoursPerDay = options.hoursPerDay ?? 8;
  const daysPerWeek = options.daysPerWeek ?? 5;
  const defaultUnit = options.defaultUnit ?? "h";
  const raw = text.trim().toLowerCase();
  if (!raw) return null;

  const clock = /^(\d{1,3}):([0-5]\d)$/.exec(raw);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]);

  const pattern = /(\d+(?:[.,]\d+)?)\s*([a-z]*)/g;
  let total = 0;
  let matched = false;
  let match = pattern.exec(raw);
  while (match) {
    const amount = Number((match[1] ?? "0").replace(",", "."));
    if (Number.isFinite(amount)) {
      const alias = DURATION_ALIASES[match[2] ?? ""] ?? defaultUnit;
      total += amount * unitMinutes(alias, hoursPerDay, daysPerWeek);
      matched = true;
    }
    match = pattern.exec(raw);
  }
  return matched ? Math.round(total) : null;
}

/** MINUTES → `"2d 4h"`, decomposed largest-unit-first. */
export function formatDuration(minutes: number, options: DurationOptions = {}): string {
  const hoursPerDay = options.hoursPerDay ?? 8;
  const daysPerWeek = options.daysPerWeek ?? 5;
  const units = options.units ?? (["d", "h"] as const);
  if (!Number.isFinite(minutes)) return "";
  const negative = minutes < 0;
  let remaining = Math.abs(Math.round(minutes));
  const pieces: string[] = [];

  const ordered = (["w", "d", "h", "m"] as const).filter((unit) => units.includes(unit));
  ordered.forEach((unit, index) => {
    const size = unitMinutes(unit, hoursPerDay, daysPerWeek);
    const isLast = index === ordered.length - 1;
    if (isLast) {
      const amount = remaining / size;
      if (amount > 0 || pieces.length === 0) {
        pieces.push(`${roundTo(amount, 2)}${unit}`);
      }
      remaining = 0;
      return;
    }
    const whole = Math.floor(remaining / size);
    if (whole > 0) {
      pieces.push(`${whole}${unit}`);
      remaining -= whole * size;
    }
  });

  return `${negative ? "-" : ""}${pieces.join(" ")}`;
}

export interface DurationInputProps extends DurationOptions {
  /** Canonical value in MINUTES. */
  value?: number | null;
  defaultValue?: number | null;
  onChange?: (minutes: number | null) => void;
  min?: number;
  max?: number;
  placeholder?: string;
  size?: InputSize;
  disabled?: boolean;
  invalid?: boolean;
  required?: boolean;
  readOnly?: boolean;
  name?: string;
  id?: string;
  className?: string;
  autoFocus?: boolean;
  /** Muted helper under the field showing the parsed value. Default `true`. */
  showParsedHint?: boolean;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  onBlur?: () => void;
}

/**
 * Duration entry in the units a scheduler actually types.
 *
 *   <DurationInput value={minutes} onChange={setMinutes} units={["d", "h"]} />
 */
export function DurationInput({
  value,
  defaultValue = null,
  onChange,
  min,
  max,
  hoursPerDay = 8,
  daysPerWeek = 5,
  units = ["d", "h"],
  defaultUnit = "h",
  placeholder = "e.g. 2d 4h",
  size = "md",
  disabled,
  invalid,
  required,
  readOnly,
  name,
  id,
  className,
  autoFocus,
  showParsedHint = true,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  "aria-describedby": ariaDescribedBy,
  onBlur,
}: DurationInputProps) {
  const [current, setCurrent] = useControllableState<number | null>(
    value,
    defaultValue,
    undefined,
  );
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const emitChange = useEvent(onChange);
  const config = useMemo(
    () => ({ hoursPerDay, daysPerWeek, units, defaultUnit }),
    [daysPerWeek, defaultUnit, hoursPerDay, units],
  );

  const commit = useCallback(
    (minutes: number | null) => {
      let next = minutes;
      if (next !== null) {
        if (typeof min === "number" && next < min) next = min;
        if (typeof max === "number" && next > max) next = max;
      }
      setCurrent(next);
      emitChange(next);
    },
    [emitChange, max, min, setCurrent],
  );

  const formatted = current === null ? "" : formatDuration(current, config);
  const display = focused ? text : formatted;
  const preview = focused ? parseDuration(text, config) : null;

  return (
    <div className={cx("w-full", className)} data-slot="duration-input">
      <div className={cx(shellClass(size, invalid, disabled), SIZE_H[size], SIZE_PX[size])}>
        <IconClock size={SIZE_ICON[size]} className="mr-1.5 shrink-0 text-content-subtle" />
        <input
          id={id}
          type="text"
          autoComplete="off"
          spellCheck={false}
          autoFocus={autoFocus}
          disabled={disabled}
          readOnly={readOnly}
          required={required}
          value={display}
          placeholder={placeholder}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          aria-describedby={ariaDescribedBy}
          aria-invalid={invalid || undefined}
          onFocus={() => {
            setFocused(true);
            setText(formatted);
          }}
          onBlur={() => {
            setFocused(false);
            const parsed = parseDuration(text, config);
            commit(text.trim() === "" ? null : parsed);
            onBlur?.();
          }}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            const parsed = parseDuration(text, config);
            commit(text.trim() === "" ? null : parsed);
          }}
          className={cx(BARE_INPUT, "tabular-nums")}
        />
        {name ? <input type="hidden" name={name} value={current ?? ""} /> : null}
      </div>
      {showParsedHint && focused && preview !== null ? (
        <p className="mt-1 text-meta text-content-subtle" aria-live="polite">
          {formatDuration(preview, config)} ·{" "}
          {roundTo(preview / 60, 2)}h
        </p>
      ) : null}
    </div>
  );
}

/* ==========================================================================
   TagInput
   ========================================================================== */

export interface TagInputProps {
  value?: readonly string[];
  defaultValue?: readonly string[];
  onChange?: (tags: string[]) => void;
  /** Static suggestions offered while typing. */
  suggestions?: readonly string[];
  /** Async suggestions. Debounced and abortable. */
  loadSuggestions?: (query: string, signal: AbortSignal) => Promise<readonly string[]>;
  debounce?: number;
  placeholder?: string;
  /** Cap the number of tags. */
  max?: number;
  /** Per-tag character cap. */
  maxLength?: number;
  allowDuplicates?: boolean;
  /** Characters that also commit a tag. Enter and Tab always do. Default `[","]`. */
  delimiters?: readonly string[];
  /** Return an error string to reject the tag, or `null` to accept it. */
  validate?: (tag: string, existing: readonly string[]) => string | null;
  /** Applied before validation and storage. Default: trim. */
  normalize?: (tag: string) => string;
  /** Chip tone, or a function of the tag. */
  tone?: Tone | ((tag: string) => Tone);
  size?: InputSize;
  disabled?: boolean;
  invalid?: boolean;
  required?: boolean;
  name?: string;
  id?: string;
  className?: string;
  autoFocus?: boolean;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  onBlur?: () => void;
}

/**
 * Free-text tag entry with chips, paste splitting and optional suggestions.
 *
 *   <TagInput value={labels} onChange={setLabels} suggestions={KNOWN_LABELS} />
 */
export function TagInput({
  value,
  defaultValue,
  onChange,
  suggestions,
  loadSuggestions,
  debounce = 220,
  placeholder = "Add a tag…",
  max,
  maxLength = 64,
  allowDuplicates = false,
  delimiters = [","],
  validate,
  normalize,
  tone: chipTone = "neutral",
  size = "md",
  disabled = false,
  invalid = false,
  required = false,
  name,
  id,
  className,
  autoFocus,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  "aria-describedby": ariaDescribedBy,
  onBlur,
}: TagInputProps) {
  const fieldId = useIsomorphicId(id);
  const listId = `${fieldId}-suggestions`;
  const [tags, setTags] = useControllableState<readonly string[]>(
    value,
    defaultValue ?? [],
    undefined,
  );
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const emitChange = useEvent(onChange);
  const normalizeTag = useEvent(normalize);
  const validateTag = useEvent(validate);

  const async = useAsyncOptions(
    loadSuggestions,
    text,
    open && Boolean(loadSuggestions),
    debounce,
  );

  const pool = loadSuggestions ? async.options : (suggestions ?? []);
  const available = useMemo(() => {
    const taken = new Set(tags.map((tag) => tag.toLowerCase()));
    const query = normalise(text.trim());
    return pool
      .filter((item) => !taken.has(item.toLowerCase()))
      .filter((item) => (query ? normalise(item).includes(query) : true))
      .slice(0, 50);
  }, [pool, tags, text]);

  const apply = useCallback(
    (next: readonly string[]) => {
      const list = [...next];
      setTags(list);
      emitChange(list);
    },
    [emitChange, setTags],
  );

  const addTag = useCallback(
    (raw: string) => {
      const clean = (normalizeTag(raw) ?? raw.trim()).slice(0, maxLength);
      if (!clean) return false;
      if (typeof max === "number" && tags.length >= max) {
        setError(`Up to ${max} tags`);
        return false;
      }
      if (
        !allowDuplicates &&
        tags.some((tag) => tag.toLowerCase() === clean.toLowerCase())
      ) {
        setError("Already added");
        return false;
      }
      const message = validateTag(clean, tags);
      if (message) {
        setError(message);
        return false;
      }
      setError(null);
      apply([...tags, clean]);
      return true;
    },
    [allowDuplicates, apply, max, maxLength, normalizeTag, tags, validateTag],
  );

  const splitPattern = useMemo(() => {
    const escaped = delimiters
      .map((delimiter) => delimiter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("");
    return new RegExp(`[${escaped}\\n\\r\\t]+`);
  }, [delimiters]);

  const handlePaste = (event: ReactClipboardEvent<HTMLInputElement>) => {
    const pasted = event.clipboardData.getData("text/plain");
    if (!pasted) return;
    const pieces = pasted.split(splitPattern).filter((piece) => piece.trim().length > 0);
    if (pieces.length <= 1 && !splitPattern.test(pasted)) return;
    event.preventDefault();
    let added: string[] = [...tags];
    for (const piece of pieces) {
      const clean = (normalizeTag(piece) ?? piece.trim()).slice(0, maxLength);
      if (!clean) continue;
      if (typeof max === "number" && added.length >= max) break;
      if (!allowDuplicates && added.some((tag) => tag.toLowerCase() === clean.toLowerCase())) {
        continue;
      }
      if (validateTag(clean, added)) continue;
      added = [...added, clean];
    }
    apply(added);
    setText("");
  };

  const resolveTone = (tag: string): Tone =>
    typeof chipTone === "function" ? chipTone(tag) : chipTone;

  const chipSize = size === "lg" ? "md" : size === "xs" ? "xs" : "sm";

  return (
    <div className={cx("relative w-full", className)} data-slot="tag-input">
      <div
        ref={setAnchor}
        className={cx(
          shellClass(size, invalid || Boolean(error), disabled),
          SIZE_MIN_H[size],
          "h-auto flex-wrap items-center gap-1 py-1",
          SIZE_PX[size],
        )}
        onMouseDown={(event: ReactMouseEvent<HTMLDivElement>) => {
          if (disabled) return;
          if ((event.target as HTMLElement).closest("button")) return;
          inputRef.current?.focus();
        }}
      >
        {tags.map((tag) => (
          <Tag
            key={tag}
            size={chipSize}
            tone={resolveTone(tag)}
            selected={resolveTone(tag) !== "neutral"}
            removeLabel={`Remove ${tag}`}
            onRemove={disabled ? undefined : () => apply(tags.filter((item) => item !== tag))}
            className="max-w-[14rem]"
          >
            {tag}
          </Tag>
        ))}
        <input
          ref={inputRef}
          id={fieldId}
          type="text"
          role="combobox"
          autoComplete="off"
          spellCheck={false}
          autoFocus={autoFocus}
          disabled={disabled}
          required={required && tags.length === 0}
          value={text}
          maxLength={maxLength}
          placeholder={tags.length === 0 ? placeholder : ""}
          aria-expanded={open && available.length > 0}
          aria-controls={open ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={
            open && available[activeIndex] ? `${listId}-s${activeIndex}` : undefined
          }
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          aria-describedby={ariaDescribedBy}
          aria-invalid={invalid || Boolean(error) || undefined}
          onChange={(event) => {
            const next = event.target.value;
            if (delimiters.some((delimiter) => next.endsWith(delimiter))) {
              const candidate = next.slice(0, -1);
              if (candidate.trim()) {
                if (addTag(candidate)) setText("");
              }
              return;
            }
            setText(next);
            setError(null);
            setActiveIndex(0);
            if (!open) setOpen(true);
          }}
          onPaste={handlePaste}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            setOpen(false);
            if (text.trim() && addTag(text)) setText("");
            onBlur?.();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              const suggestion = open ? available[activeIndex] : undefined;
              if (suggestion && !text.trim()) {
                if (addTag(suggestion)) setText("");
                return;
              }
              if (text.trim() && addTag(text)) setText("");
              return;
            }
            if (event.key === "Tab" && text.trim()) {
              if (addTag(text)) {
                event.preventDefault();
                setText("");
              }
              return;
            }
            if (event.key === "Backspace" && text === "" && tags.length > 0) {
              event.preventDefault();
              apply(tags.slice(0, -1));
              return;
            }
            if (event.key === "ArrowDown" && available.length > 0) {
              event.preventDefault();
              setOpen(true);
              setActiveIndex((index) => Math.min(available.length - 1, index + 1));
              return;
            }
            if (event.key === "ArrowUp" && available.length > 0) {
              event.preventDefault();
              setActiveIndex((index) => Math.max(0, index - 1));
            }
          }}
          className={cx(BARE_INPUT, "h-6 min-w-[6rem] flex-1")}
        />
        {tags.length > 0 && !disabled ? (
          <ClearButton onClear={() => apply([])} label="Remove all tags" className="ml-0.5" />
        ) : null}
      </div>

      {name
        ? tags.map((tag) => <input key={tag} type="hidden" name={name} value={tag} />)
        : null}

      {error ? (
        <p className="mt-1 flex items-center gap-1 text-meta text-danger-fg" role="alert">
          <IconAlert size={12} />
          {error}
        </p>
      ) : typeof max === "number" ? (
        <p className="mt-1 text-meta text-content-subtle">
          {tags.length} / {max}
        </p>
      ) : null}

      <AnchoredPanel
        open={open && available.length > 0}
        onOpenChange={setOpen}
        anchor={anchor}
        matchAnchorWidth
        maxHeight={240}
        id={listId}
        role="listbox"
        ariaLabel="Tag suggestions"
      >
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5">
          {available.map((suggestion, index) => (
            <div
              key={suggestion}
              id={`${listId}-s${index}`}
              role="option"
              aria-selected={false}
              data-active={index === activeIndex}
              onMouseEnter={() => setActiveIndex(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                if (addTag(suggestion)) setText("");
                inputRef.current?.focus();
              }}
              className={OPTION_ROW}
            >
              <span className="truncate">{highlightMatch(suggestion, text)}</span>
            </div>
          ))}
        </div>
      </AnchoredPanel>
    </div>
  );
}

/* ==========================================================================
   FileDropzone
   ========================================================================== */

/** `1536000` → `"1.5 MB"`. Binary units, one decimal by default. */
export function formatBytes(bytes: number, decimals = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const scaled = bytes / 1024 ** exponent;
  const unit = units[exponent] ?? "B";
  return `${exponent === 0 ? Math.round(scaled) : scaled.toFixed(decimals)} ${unit}`;
}

export type DropzoneStatus = "pending" | "uploading" | "done" | "error";

export interface DropzoneFile {
  /** Client-side identity. Stable for the lifetime of the row. */
  id: string;
  file: File;
  name: string;
  size: number;
  type: string;
  status: DropzoneStatus;
  /** 0–100. Only meaningful while `status === "uploading"`. */
  progress: number;
  error?: string | null;
  /** Object URL (images) or data URL (PDF first page). Revoked on removal. */
  previewUrl?: string | null;
  /** Whatever the uploader resolved with. */
  url?: string | null;
}

export interface FileRejection {
  file: File;
  reason: string;
}

export interface DropzoneUploadContext {
  onProgress: (percent: number) => void;
  signal: AbortSignal;
}

export interface FileDropzoneHandle {
  /** Open the OS file picker. */
  open: () => void;
  /** Remove every row (aborting in-flight uploads). */
  clear: () => void;
  remove: (id: string) => void;
  retry: (id: string) => void;
  /** Current rows. */
  files: () => DropzoneFile[];
}

export interface FileDropzoneProps {
  /** Fires whenever the list changes — additions, progress, completion, removal. */
  onFilesChange?: (files: DropzoneFile[]) => void;
  /** Fires once per batch with the accepted `File`s only. */
  onAccepted?: (files: File[]) => void;
  onRejected?: (rejections: FileRejection[]) => void;
  /**
   * Per-file uploader. Report progress through `ctx.onProgress` and honour
   * `ctx.signal`. Resolve with `{ url }` to record the stored location.
   */
  upload?: (file: File, ctx: DropzoneUploadContext) => Promise<{ url?: string } | void>;
  /** Start uploading as soon as a file is accepted. Default `true`. */
  autoUpload?: boolean;

  /** Standard `accept` syntax: `"image/*,.pdf,application/vnd.ms-excel"`. */
  accept?: string;
  multiple?: boolean;
  maxFiles?: number;
  /** Per-file byte cap. */
  maxSize?: number;
  /** Combined byte cap across all files. */
  maxTotalSize?: number;

  /** Where paste-to-upload listens. Default `"self"` (the zone must be focused). */
  pasteTarget?: "self" | "window" | false;
  /** Render thumbnails for images and PDFs. Default `true`. */
  showPreviews?: boolean;

  label?: ReactNode;
  hint?: ReactNode;
  /** `"zone"` is the full drop target; `"compact"` is a one-line button + list. */
  variant?: "zone" | "compact";
  disabled?: boolean;
  invalid?: boolean;
  className?: string;
  id?: string;
  /** Emits one hidden input per uploaded URL, for native form posts. */
  name?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
}

function matchesAccept(file: File, accept?: string): boolean {
  if (!accept) return true;
  const rules = accept
    .split(",")
    .map((rule) => rule.trim().toLowerCase())
    .filter(Boolean);
  if (rules.length === 0) return true;
  const name = file.name.toLowerCase();
  const type = (file.type || "").toLowerCase();
  return rules.some((rule) => {
    if (rule.startsWith(".")) return name.endsWith(rule);
    if (rule.endsWith("/*")) return type.startsWith(rule.slice(0, -1));
    return type === rule;
  });
}

function fileGlyph(type: string, name: string): IconComponent {
  const lower = (type || name).toLowerCase();
  if (lower.startsWith("image/") || /\.(png|jpe?g|gif|webp|avif|svg)$/.test(lower)) {
    return IconPhoto;
  }
  if (lower.includes("pdf")) return IconDocument;
  if (/\.(xlsx?|csv)$/.test(lower) || lower.includes("spreadsheet")) return IconFile;
  return IconAttachment;
}

/**
 * Render page 1 of a PDF to a data URL. pdf.js is imported lazily so the
 * ~1MB engine only loads if someone actually drops a PDF, and every failure
 * mode degrades to "no thumbnail" rather than a broken row.
 */
async function renderPdfThumbnail(file: File, targetWidth = 96): Promise<string | null> {
  try {
    const [pdfjs, worker] = await Promise.all([
      import("pdfjs-dist/legacy/build/pdf.mjs"),
      import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"),
    ]);
    if (!pdfjs.GlobalWorkerOptions.workerSrc) {
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    }
    const buffer = await file.arrayBuffer();
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
    try {
      const page = await doc.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
      const scale = (targetWidth * dpr) / base.width;
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      await page.render({ canvas, viewport }).promise;
      return canvas.toDataURL("image/jpeg", 0.72);
    } finally {
      void doc.loadingTask.destroy().catch(() => undefined);
    }
  } catch {
    return null;
  }
}

let dropzoneSeq = 0;

/**
 * Drag-and-drop / click / paste file intake with validation, per-file
 * progress and thumbnails.
 *
 *   <FileDropzone accept="image/*,.pdf" maxSize={25 * 1024 * 1024}
 *                 upload={(file, ctx) => api.uploadAttachment(file, ctx)}
 *                 onFilesChange={setAttachments} />
 */
export const FileDropzone = forwardRef<FileDropzoneHandle, FileDropzoneProps>(
  function FileDropzone(
    {
      onFilesChange,
      onAccepted,
      onRejected,
      upload,
      autoUpload = true,
      accept,
      multiple = true,
      maxFiles,
      maxSize,
      maxTotalSize,
      pasteTarget = "self",
      showPreviews = true,
      label,
      hint,
      variant = "zone",
      disabled = false,
      invalid = false,
      className,
      id,
      name,
      "aria-label": ariaLabel,
      "aria-describedby": ariaDescribedBy,
    },
    ref,
  ) {
    const fieldId = useIsomorphicId(id);
    const [files, setFiles] = useState<DropzoneFile[]>([]);
    const [dragging, setDragging] = useState(false);
    const [rejections, setRejections] = useState<FileRejection[]>([]);
    const dragDepth = useRef(0);
    const inputRef = useRef<HTMLInputElement | null>(null);
    const zoneRef = useRef<HTMLDivElement | null>(null);
    const controllers = useRef(new Map<string, AbortController>());
    const objectUrls = useRef(new Set<string>());
    const filesRef = useRef<DropzoneFile[]>([]);
    filesRef.current = files;

    const emitFiles = useEvent(onFilesChange);
    const emitAccepted = useEvent(onAccepted);
    const emitRejected = useEvent(onRejected);
    const uploader = useEvent(upload);
    const hasUploader = Boolean(upload);

    useEffect(() => {
      emitFiles(files);
    }, [files, emitFiles]);

    useEffect(() => {
      const urls = objectUrls.current;
      const inflight = controllers.current;
      return () => {
        urls.forEach((url) => URL.revokeObjectURL(url));
        urls.clear();
        inflight.forEach((controller) => controller.abort());
        inflight.clear();
      };
    }, []);

    const patch = useCallback((entryId: string, next: Partial<DropzoneFile>) => {
      setFiles((current) =>
        current.map((entry) => (entry.id === entryId ? { ...entry, ...next } : entry)),
      );
    }, []);

    const startUpload = useCallback(
      (entry: DropzoneFile) => {
        if (!hasUploader) return;
        controllers.current.get(entry.id)?.abort();
        const controller = new AbortController();
        controllers.current.set(entry.id, controller);
        patch(entry.id, { status: "uploading", progress: 0, error: null });

        void (async () => {
          try {
            const result = await uploader(entry.file, {
              signal: controller.signal,
              onProgress: (percent) =>
                patch(entry.id, {
                  progress: Math.max(0, Math.min(100, Math.round(percent))),
                }),
            });
            if (controller.signal.aborted) return;
            patch(entry.id, {
              status: "done",
              progress: 100,
              url: (result && "url" in result ? result.url : undefined) ?? null,
            });
          } catch (error) {
            if (controller.signal.aborted) return;
            patch(entry.id, {
              status: "error",
              error: error instanceof Error ? error.message : "Upload failed",
            });
          } finally {
            controllers.current.delete(entry.id);
          }
        })();
      },
      [hasUploader, patch, uploader],
    );

    const attachPreview = useCallback(
      (entry: DropzoneFile) => {
        if (!showPreviews) return;
        if (entry.type.startsWith("image/")) {
          const url = URL.createObjectURL(entry.file);
          objectUrls.current.add(url);
          patch(entry.id, { previewUrl: url });
          return;
        }
        if (entry.type === "application/pdf" || /\.pdf$/i.test(entry.name)) {
          void renderPdfThumbnail(entry.file).then((dataUrl) => {
            if (dataUrl) patch(entry.id, { previewUrl: dataUrl });
          });
        }
      },
      [patch, showPreviews],
    );

    const addFiles = useCallback(
      (incoming: FileList | File[] | null) => {
        if (disabled || !incoming) return;
        const list = Array.from(incoming);
        if (list.length === 0) return;

        const accepted: DropzoneFile[] = [];
        const refused: FileRejection[] = [];
        const existing = filesRef.current;
        let total = existing.reduce((sum, entry) => sum + entry.size, 0);
        let count = existing.length;

        for (const file of list) {
          if (!multiple && count >= 1 && accepted.length >= 1) {
            refused.push({ file, reason: "Only one file allowed" });
            continue;
          }
          if (typeof maxFiles === "number" && count >= maxFiles) {
            refused.push({ file, reason: `At most ${maxFiles} files` });
            continue;
          }
          if (!matchesAccept(file, accept)) {
            refused.push({ file, reason: "File type not allowed" });
            continue;
          }
          if (typeof maxSize === "number" && file.size > maxSize) {
            refused.push({ file, reason: `Larger than ${formatBytes(maxSize)}` });
            continue;
          }
          if (typeof maxTotalSize === "number" && total + file.size > maxTotalSize) {
            refused.push({ file, reason: `Exceeds the ${formatBytes(maxTotalSize)} total` });
            continue;
          }
          if (
            existing.some(
              (entry) =>
                entry.name === file.name &&
                entry.size === file.size &&
                entry.file.lastModified === file.lastModified,
            )
          ) {
            refused.push({ file, reason: "Already added" });
            continue;
          }

          dropzoneSeq += 1;
          accepted.push({
            id: `dz-${Date.now().toString(36)}-${dropzoneSeq}`,
            file,
            name: file.name,
            size: file.size,
            type: file.type,
            status: "pending",
            progress: 0,
            error: null,
            previewUrl: null,
            url: null,
          });
          total += file.size;
          count += 1;
        }

        if (accepted.length > 0) {
          setFiles((current) => (multiple ? [...current, ...accepted] : accepted));
          emitAccepted(accepted.map((entry) => entry.file));
          accepted.forEach((entry) => {
            attachPreview(entry);
            if (autoUpload && hasUploader) startUpload(entry);
          });
        }
        setRejections(refused);
        if (refused.length > 0) emitRejected(refused);
      },
      [
        accept,
        attachPreview,
        autoUpload,
        disabled,
        emitAccepted,
        emitRejected,
        hasUploader,
        maxFiles,
        maxSize,
        maxTotalSize,
        multiple,
        startUpload,
      ],
    );

    const removeFile = useCallback((entryId: string) => {
      controllers.current.get(entryId)?.abort();
      controllers.current.delete(entryId);
      setFiles((current) => {
        const target = current.find((entry) => entry.id === entryId);
        if (target?.previewUrl && target.previewUrl.startsWith("blob:")) {
          URL.revokeObjectURL(target.previewUrl);
          objectUrls.current.delete(target.previewUrl);
        }
        return current.filter((entry) => entry.id !== entryId);
      });
    }, []);

    const clearAll = useCallback(() => {
      controllers.current.forEach((controller) => controller.abort());
      controllers.current.clear();
      objectUrls.current.forEach((url) => URL.revokeObjectURL(url));
      objectUrls.current.clear();
      setFiles([]);
      setRejections([]);
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        open: () => inputRef.current?.click(),
        clear: clearAll,
        remove: removeFile,
        retry: (entryId: string) => {
          const entry = filesRef.current.find((item) => item.id === entryId);
          if (entry) startUpload(entry);
        },
        files: () => filesRef.current,
      }),
      [clearAll, removeFile, startUpload],
    );

    /* Paste-to-upload. */
    useEffect(() => {
      if (pasteTarget !== "window" || disabled) return;
      const handler = (event: ClipboardEvent) => {
        const pasted = event.clipboardData?.files;
        if (pasted && pasted.length > 0) {
          event.preventDefault();
          addFiles(pasted);
        }
      };
      window.addEventListener("paste", handler);
      return () => window.removeEventListener("paste", handler);
    }, [addFiles, disabled, pasteTarget]);

    const onDrop = (event: ReactDragEvent<HTMLDivElement>) => {
      event.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      if (disabled) return;
      addFiles(event.dataTransfer?.files ?? null);
    };

    const totalBytes = files.reduce((sum, entry) => sum + entry.size, 0);
    const uploading = files.some((entry) => entry.status === "uploading");

    return (
      <div className={cx("w-full", className)} data-slot="file-dropzone">
        <input
          ref={inputRef}
          id={fieldId}
          type="file"
          accept={accept}
          multiple={multiple}
          disabled={disabled}
          className="sr-only absolute size-px overflow-hidden"
          onChange={(event) => {
            addFiles(event.target.files);
            event.target.value = "";
          }}
        />

        <div
          ref={zoneRef}
          role="button"
          tabIndex={disabled ? -1 : 0}
          aria-label={ariaLabel ?? "Add files"}
          aria-describedby={ariaDescribedBy}
          aria-disabled={disabled || undefined}
          aria-invalid={invalid || undefined}
          data-dragging={dragging ? "true" : "false"}
          onClick={() => {
            if (!disabled) inputRef.current?.click();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              if (!disabled) inputRef.current?.click();
            }
          }}
          onPaste={
            pasteTarget === "self"
              ? (event: ReactClipboardEvent<HTMLDivElement>) => {
                  const pasted = event.clipboardData?.files;
                  if (pasted && pasted.length > 0) {
                    event.preventDefault();
                    addFiles(pasted);
                  }
                }
              : undefined
          }
          onDragEnter={(event: ReactDragEvent<HTMLDivElement>) => {
            event.preventDefault();
            dragDepth.current += 1;
            if (!disabled) setDragging(true);
          }}
          onDragOver={(event: ReactDragEvent<HTMLDivElement>) => {
            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
          }}
          onDragLeave={(event: ReactDragEvent<HTMLDivElement>) => {
            event.preventDefault();
            dragDepth.current = Math.max(0, dragDepth.current - 1);
            if (dragDepth.current === 0) setDragging(false);
          }}
          onDrop={onDrop}
          className={cx(
            "relative flex cursor-pointer select-none flex-col items-center justify-center",
            "overflow-hidden rounded-lg border border-dashed text-center transition-colors",
            variant === "zone" ? "gap-1 px-6 py-8" : "flex-row gap-2 px-3 py-2.5",
            dragging
              ? "border-accent bg-accent-subtle"
              : invalid
                ? "border-danger-border bg-danger-subtle/40 hover:border-danger-solid"
                : "border-border bg-surface-raised/60 hover:border-border-strong hover:bg-surface-hover",
            disabled && "pointer-events-none opacity-55",
          )}
        >
          {variant === "zone" ? (
            <>
              <span
                className="pointer-events-none absolute inset-0 grid-bg opacity-40 mask-fade-y"
                aria-hidden="true"
              />
              <span
                className={cx(
                  "relative grid size-11 place-items-center rounded-xl border shadow-e0 transition-colors",
                  dragging
                    ? "border-accent-border bg-accent-subtle text-accent-subtle-fg"
                    : "border-border bg-surface-sunken text-content-muted",
                )}
                aria-hidden="true"
              >
                <IconUpload size={20} />
              </span>
              <p className="relative mt-2 text-body font-medium text-content">
                {label ?? (dragging ? "Drop to upload" : "Drop files or click to browse")}
              </p>
              <p className="relative max-w-prose text-balance text-meta text-content-subtle">
                {hint ?? (
                  <>
                    {accept ? `${accept.split(",").length} accepted types` : "Any file type"}
                    {maxSize ? ` · up to ${formatBytes(maxSize)} each` : ""}
                    {maxFiles ? ` · max ${maxFiles} files` : ""}
                    {pasteTarget ? " · paste works too" : ""}
                  </>
                )}
              </p>
            </>
          ) : (
            <>
              <IconUpload size={15} className="shrink-0 text-content-subtle" />
              <span className="min-w-0 flex-1 truncate text-left text-body text-content-muted">
                {label ?? "Drop files, click to browse, or paste"}
              </span>
              {hint ? (
                <span className="shrink-0 text-meta text-content-subtle">{hint}</span>
              ) : null}
            </>
          )}
        </div>

        {rejections.length > 0 ? (
          <ul className="mt-2 space-y-1" role="alert">
            {rejections.map((rejection, index) => (
              <li
                key={`${rejection.file.name}-${index}`}
                className="flex items-center gap-1.5 text-meta text-danger-fg"
              >
                <IconWarning size={12} className="shrink-0" />
                <span className="truncate">
                  <span className="font-medium">{rejection.file.name}</span> · {rejection.reason}
                </span>
              </li>
            ))}
          </ul>
        ) : null}

        {files.length > 0 ? (
          <>
            <ul className="mt-2 space-y-1.5">
              {files.map((entry) => {
                const Glyph = fileGlyph(entry.type, entry.name);
                return (
                  <li
                    key={entry.id}
                    className={cx(
                      "relative flex items-center gap-2.5 overflow-hidden rounded-md border",
                      "border-border bg-surface-raised px-2 py-1.5",
                      entry.status === "error" && "border-danger-border",
                    )}
                  >
                    <span
                      className={cx(
                        "grid size-9 shrink-0 place-items-center overflow-hidden rounded",
                        "border border-border-subtle bg-surface-sunken text-content-subtle",
                      )}
                      aria-hidden="true"
                    >
                      {entry.previewUrl ? (
                        <img
                          src={entry.previewUrl}
                          alt=""
                          className="size-full object-cover drag-none"
                        />
                      ) : (
                        <Glyph size={16} />
                      )}
                    </span>

                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-body text-content">{entry.name}</span>
                        {entry.status === "done" ? (
                          <IconCheck size={12} className="shrink-0 text-success-fg" />
                        ) : null}
                      </span>
                      <span className="mt-0.5 flex items-center gap-1.5 text-meta text-content-subtle">
                        <span className="tabular-nums">{formatBytes(entry.size)}</span>
                        {entry.status === "uploading" ? (
                          <span className="tabular-nums">· {entry.progress}%</span>
                        ) : null}
                        {entry.status === "error" ? (
                          <span className="truncate text-danger-fg">
                            · {entry.error ?? "Failed"}
                          </span>
                        ) : null}
                      </span>
                      {entry.status === "uploading" ? (
                        <span
                          role="progressbar"
                          aria-valuenow={entry.progress}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-label={`Uploading ${entry.name}`}
                          className="mt-1 block h-1 w-full overflow-hidden rounded-full bg-surface-sunken"
                        >
                          <span
                            className="block h-full rounded-full bg-accent transition-[width] duration-base ease-standard"
                            style={{ width: `${entry.progress}%` }}
                          />
                        </span>
                      ) : null}
                    </span>

                    {entry.status === "error" && hasUploader ? (
                      <button
                        type="button"
                        onClick={() => startUpload(entry)}
                        aria-label={`Retry ${entry.name}`}
                        className="grid size-6 shrink-0 place-items-center rounded text-content-subtle hover:bg-surface-hover hover:text-content"
                      >
                        <IconRefresh size={13} />
                      </button>
                    ) : null}
                    {entry.status === "pending" && hasUploader && !autoUpload ? (
                      <button
                        type="button"
                        onClick={() => startUpload(entry)}
                        aria-label={`Upload ${entry.name}`}
                        className="grid size-6 shrink-0 place-items-center rounded text-content-subtle hover:bg-surface-hover hover:text-content"
                      >
                        <IconUpload size={13} />
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => removeFile(entry.id)}
                      aria-label={`Remove ${entry.name}`}
                      className="grid size-6 shrink-0 place-items-center rounded text-content-subtle hover:bg-danger-subtle hover:text-danger-fg"
                    >
                      <IconTrash size={13} />
                    </button>

                    {name && entry.url ? (
                      <input type="hidden" name={name} value={entry.url} />
                    ) : null}
                  </li>
                );
              })}
            </ul>
            <div className="mt-1.5 flex items-center justify-between text-meta text-content-subtle">
              <span className="tabular-nums">
                {files.length} file{files.length === 1 ? "" : "s"} ·{" "}
                {formatBytes(totalBytes)}
                {uploading ? " · uploading…" : ""}
              </span>
              <button
                type="button"
                onClick={clearAll}
                className="rounded px-1.5 py-0.5 font-medium text-content-muted hover:bg-surface-hover hover:text-content"
              >
                Remove all
              </button>
            </div>
          </>
        ) : null}
      </div>
    );
  },
);

/* ==========================================================================
   SignaturePad
   ========================================================================== */

interface SignatureStroke {
  width: number;
  points: Array<{ x: number; y: number }>;
}

export interface SignaturePadHandle {
  clear: () => void;
  undo: () => void;
  isEmpty: () => boolean;
  /** `null` when nothing has been drawn. */
  toDataURL: (type?: string, quality?: number) => string | null;
  toBlob: (type?: string, quality?: number) => Promise<Blob | null>;
}

export interface SignaturePadProps {
  /** Fires after every completed stroke. `null` once cleared. */
  onChange?: (dataUrl: string | null) => void;
  onBegin?: () => void;
  onEnd?: () => void;
  /** Canvas height in CSS px. Default 160. */
  height?: number;
  /** Pen width in CSS px. Default 2.2. */
  penWidth?: number;
  /**
   * Ink used when exporting. The on-screen ink follows the theme; the export
   * has to look right on a printed page, so it defaults to near-black and is
   * overridable rather than token-bound.
   */
  exportInk?: string;
  /** Export background. Default `"transparent"`. */
  exportBackground?: string;
  label?: ReactNode;
  hint?: ReactNode;
  /** Draw the signing baseline. Default `true`. */
  showGuide?: boolean;
  /** Show Undo / Clear. Default `true`. */
  showActions?: boolean;
  /** Offer a typed signature for keyboard and AT users. Default `true`. */
  allowTyped?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  invalid?: boolean;
  className?: string;
  id?: string;
  /** Hidden input carrying the data URL, for native form posts. */
  name?: string;
  "aria-label"?: string;
}

/**
 * Canvas signature capture with pressure-free smoothing, undo, and a typed
 * fallback so the control is not mouse-only.
 *
 *   const pad = useRef<SignaturePadHandle>(null);
 *   <SignaturePad ref={pad} onChange={setSignature} />
 */
export const SignaturePad = forwardRef<SignaturePadHandle, SignaturePadProps>(
  function SignaturePad(
    {
      onChange,
      onBegin,
      onEnd,
      height = 160,
      penWidth = 2.2,
      exportInk = "#111827",
      exportBackground = "transparent",
      label = "Sign here",
      hint,
      showGuide = true,
      showActions = true,
      allowTyped = true,
      disabled = false,
      readOnly = false,
      invalid = false,
      className,
      id,
      name,
      "aria-label": ariaLabel,
    },
    ref,
  ) {
    const fieldId = useIsomorphicId(id);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const wrapRef = useRef<HTMLDivElement | null>(null);
    const strokesRef = useRef<SignatureStroke[]>([]);
    const activeRef = useRef<SignatureStroke | null>(null);
    const sizeRef = useRef({ width: 0, height });
    const [empty, setEmpty] = useState(true);
    const [typed, setTyped] = useState("");
    const theme = useResolvedTheme();
    const emitChange = useEvent(onChange);
    const emitBegin = useEvent(onBegin);
    const emitEnd = useEvent(onEnd);
    const [dataUrl, setDataUrl] = useState<string | null>(null);
    const interactive = !disabled && !readOnly;

    const paint = useCallback(
      (
        ctx: CanvasRenderingContext2D,
        strokes: SignatureStroke[],
        ink: string,
        scale: number,
      ) => {
        ctx.save();
        ctx.scale(scale, scale);
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.strokeStyle = ink;
        for (const stroke of strokes) {
          const points = stroke.points;
          if (points.length === 0) continue;
          ctx.beginPath();
          ctx.lineWidth = stroke.width;
          const first = points[0];
          if (!first) continue;
          if (points.length === 1) {
            ctx.arc(first.x, first.y, stroke.width / 2, 0, Math.PI * 2);
            ctx.fillStyle = ink;
            ctx.fill();
            continue;
          }
          ctx.moveTo(first.x, first.y);
          for (let index = 1; index < points.length - 1; index += 1) {
            const current = points[index];
            const next = points[index + 1];
            if (!current || !next) continue;
            const midX = (current.x + next.x) / 2;
            const midY = (current.y + next.y) / 2;
            ctx.quadraticCurveTo(current.x, current.y, midX, midY);
          }
          const last = points[points.length - 1];
          if (last) ctx.lineTo(last.x, last.y);
          ctx.stroke();
        }
        ctx.restore();
      },
      [],
    );

    const redraw = useCallback(() => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return;
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const ink =
        readToken("content") ||
        (theme === "dark" ? "#e9ebf1" : "#0f1420");
      paint(ctx, strokesRef.current, ink, dpr);
    }, [paint, theme]);

    /* Size the backing store to the element and the device pixel ratio. */
    useEffect(() => {
      const wrap = wrapRef.current;
      const canvas = canvasRef.current;
      if (!wrap || !canvas) return;
      const resize = () => {
        const rect = wrap.getBoundingClientRect();
        const dpr = Math.max(1, window.devicePixelRatio || 1);
        sizeRef.current = { width: rect.width, height };
        canvas.width = Math.max(1, Math.floor(rect.width * dpr));
        canvas.height = Math.max(1, Math.floor(height * dpr));
        canvas.style.width = `${rect.width}px`;
        canvas.style.height = `${height}px`;
        redraw();
      };
      resize();
      const observer = new ResizeObserver(resize);
      observer.observe(wrap);
      return () => observer.disconnect();
    }, [height, redraw]);

    useEffect(() => {
      redraw();
    }, [redraw]);

    const exportCanvas = useCallback(
      (type = "image/png", quality?: number): string | null => {
        if (strokesRef.current.length === 0) return null;
        const { width } = sizeRef.current;
        if (width <= 0) return null;
        const dpr = Math.max(1, window.devicePixelRatio || 1);
        const out = document.createElement("canvas");
        out.width = Math.max(1, Math.floor(width * dpr));
        out.height = Math.max(1, Math.floor(height * dpr));
        const ctx = out.getContext("2d");
        if (!ctx) return null;
        if (exportBackground !== "transparent") {
          ctx.fillStyle = exportBackground;
          ctx.fillRect(0, 0, out.width, out.height);
        }
        paint(ctx, strokesRef.current, exportInk, dpr);
        return out.toDataURL(type, quality);
      },
      [exportBackground, exportInk, height, paint],
    );

    const publish = useCallback(() => {
      const next = exportCanvas();
      setDataUrl(next);
      setEmpty(next === null);
      emitChange(next);
    }, [emitChange, exportCanvas]);

    const clear = useCallback(() => {
      strokesRef.current = [];
      activeRef.current = null;
      setTyped("");
      redraw();
      setDataUrl(null);
      setEmpty(true);
      emitChange(null);
    }, [emitChange, redraw]);

    const undo = useCallback(() => {
      strokesRef.current = strokesRef.current.slice(0, -1);
      redraw();
      publish();
    }, [publish, redraw]);

    useImperativeHandle(
      ref,
      () => ({
        clear,
        undo,
        isEmpty: () => strokesRef.current.length === 0,
        toDataURL: (type?: string, quality?: number) => exportCanvas(type, quality),
        toBlob: async (type = "image/png", quality?: number) => {
          const url = exportCanvas(type, quality);
          if (!url) return null;
          const response = await fetch(url);
          return response.blob();
        },
      }),
      [clear, exportCanvas, undo],
    );

    const pointFrom = (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: 0, y: 0 };
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };

    /** Render a typed name as a script-ish signature onto the canvas. */
    const commitTyped = useCallback(
      (text: string) => {
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext("2d");
        if (!canvas || !ctx) return;
        strokesRef.current = [];
        redraw();
        if (!text.trim()) {
          setDataUrl(null);
          setEmpty(true);
          emitChange(null);
          return;
        }
        const dpr = Math.max(1, window.devicePixelRatio || 1);
        const { width } = sizeRef.current;
        const draw = (target: CanvasRenderingContext2D, ink: string) => {
          target.save();
          target.scale(dpr, dpr);
          target.fillStyle = ink;
          target.font = `italic ${Math.round(height * 0.34)}px ui-serif, Georgia, "Times New Roman", serif`;
          target.textBaseline = "middle";
          target.fillText(text.trim(), 18, height * 0.52, Math.max(20, width - 36));
          target.restore();
        };
        draw(ctx, readToken("content") || (theme === "dark" ? "#e9ebf1" : "#0f1420"));

        const out = document.createElement("canvas");
        out.width = Math.max(1, Math.floor(width * dpr));
        out.height = Math.max(1, Math.floor(height * dpr));
        const outCtx = out.getContext("2d");
        if (!outCtx) return;
        if (exportBackground !== "transparent") {
          outCtx.fillStyle = exportBackground;
          outCtx.fillRect(0, 0, out.width, out.height);
        }
        draw(outCtx, exportInk);
        const url = out.toDataURL("image/png");
        setDataUrl(url);
        setEmpty(false);
        emitChange(url);
      },
      [emitChange, exportBackground, exportInk, height, redraw, theme],
    );

    return (
      <div className={cx("w-full", className)} data-slot="signature-pad">
        <div
          ref={wrapRef}
          className={cx(
            "relative overflow-hidden rounded-lg border bg-surface-raised transition-colors",
            invalid ? "border-danger-border" : "border-border",
            disabled && "opacity-55",
          )}
          style={{ height }}
        >
          {showGuide ? (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-6 bottom-8 border-b border-dashed border-border-strong"
            />
          ) : null}
          {empty ? (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 bottom-3 flex items-center justify-center gap-1.5 text-meta text-content-subtle"
            >
              <IconSignature size={13} />
              {label}
            </span>
          ) : null}

          <canvas
            ref={canvasRef}
            id={fieldId}
            role="img"
            aria-label={ariaLabel ?? "Signature canvas"}
            className={cx(
              "block size-full touch-none",
              interactive ? "cursor-crosshair" : "cursor-not-allowed",
            )}
            onPointerDown={(event) => {
              if (!interactive) return;
              event.preventDefault();
              (event.target as HTMLCanvasElement).setPointerCapture(event.pointerId);
              const stroke: SignatureStroke = {
                width: penWidth,
                points: [pointFrom(event)],
              };
              activeRef.current = stroke;
              strokesRef.current = [...strokesRef.current, stroke];
              setEmpty(false);
              emitBegin();
              redraw();
            }}
            onPointerMove={(event) => {
              if (!interactive || !activeRef.current) return;
              activeRef.current.points.push(pointFrom(event));
              redraw();
            }}
            onPointerUp={(event) => {
              if (!interactive || !activeRef.current) return;
              (event.target as HTMLCanvasElement).releasePointerCapture?.(event.pointerId);
              activeRef.current = null;
              emitEnd();
              publish();
            }}
            onPointerCancel={() => {
              if (!activeRef.current) return;
              activeRef.current = null;
              publish();
            }}
          />
        </div>

        {showActions || allowTyped ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {allowTyped ? (
              <div
                className={cx(
                  shellClass("sm", false, !interactive),
                  "h-control-sm max-w-[16rem] flex-1 px-2",
                )}
              >
                <input
                  type="text"
                  value={typed}
                  disabled={!interactive}
                  placeholder="…or type your full name"
                  aria-label="Type your signature"
                  onChange={(event) => {
                    setTyped(event.target.value);
                    commitTyped(event.target.value);
                  }}
                  className={cx(BARE_INPUT, "italic")}
                />
              </div>
            ) : null}
            <span className="flex-1" />
            {showActions ? (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  leadingIcon={IconUndo}
                  disabled={!interactive || empty}
                  onClick={undo}
                >
                  Undo
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  leadingIcon={IconTrash}
                  disabled={!interactive || empty}
                  onClick={clear}
                >
                  Clear
                </Button>
              </>
            ) : null}
          </div>
        ) : null}

        {hint ? <p className="mt-1 text-meta text-content-subtle">{hint}</p> : null}
        {name ? <input type="hidden" name={name} value={dataUrl ?? ""} /> : null}
      </div>
    );
  },
);

/* ==========================================================================
   RichTextEditor
   ========================================================================== */

const RICH_ALLOWED_TAGS = new Set([
  "A", "B", "BLOCKQUOTE", "BR", "CODE", "DIV", "EM", "I", "LI", "OL", "P",
  "S", "SPAN", "STRIKE", "STRONG", "U", "UL",
]);

const RICH_ALLOWED_ATTRS: Record<string, ReadonlySet<string>> = {
  A: new Set(["href", "title", "target", "rel"]),
  SPAN: new Set(["class", "data-mention-id", "data-mention"]),
};

const SAFE_HREF = /^(https?:|mailto:|tel:|\/|#)/i;

/**
 * Strip everything that is not on the allowlist. Runs on paste, on every
 * change, and before the value is ever written back into the DOM — so a
 * hostile clipboard payload cannot survive a round trip.
 */
export function sanitizeRichText(html: string): string {
  if (typeof document === "undefined") return "";
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const walk = (node: Element) => {
    for (const child of Array.from(node.children)) {
      if (!RICH_ALLOWED_TAGS.has(child.tagName)) {
        const text = doc.createTextNode(child.textContent ?? "");
        child.replaceWith(text);
        continue;
      }
      const allowed = RICH_ALLOWED_ATTRS[child.tagName];
      for (const attribute of Array.from(child.attributes)) {
        if (!allowed?.has(attribute.name)) {
          child.removeAttribute(attribute.name);
          continue;
        }
        if (attribute.name === "href" && !SAFE_HREF.test(attribute.value.trim())) {
          child.removeAttribute("href");
        }
      }
      if (child.tagName === "A" && child.getAttribute("href")) {
        child.setAttribute("target", "_blank");
        child.setAttribute("rel", "noopener noreferrer nofollow");
      }
      walk(child);
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}

export type RichTextCommand =
  | "bold"
  | "italic"
  | "underline"
  | "strike"
  | "bulletList"
  | "orderedList"
  | "code"
  | "link";

export interface MentionCandidate {
  id: string;
  label: string;
  description?: string;
  avatarUrl?: string | null;
}

export interface RichTextEditorHandle {
  focus: () => void;
  clear: () => void;
  /** Current sanitized HTML. */
  getHTML: () => string;
  getText: () => string;
  /** Insert plain text at the caret. */
  insert: (text: string) => void;
}

export interface RichTextEditorProps {
  /** HTML. Only written into the DOM when it differs from the last emit. */
  value?: string;
  defaultValue?: string;
  onChange?: (html: string, meta: { text: string; mentions: string[] }) => void;
  placeholder?: string;
  /** `true` for the default set, or an explicit command list. `false` hides it. */
  toolbar?: boolean | readonly RichTextCommand[];
  /** Minimum editor height in rows. Default 4. */
  minRows?: number;
  /** Maximum height in rows before it scrolls. Default 16. */
  maxRows?: number;
  /** Character to open the mention list. Default `"@"`. */
  mentionTrigger?: string;
  /** Static mention candidates. */
  mentions?: readonly MentionCandidate[];
  /** Async mention candidates. Debounced and abortable. */
  loadMentions?: (
    query: string,
    signal: AbortSignal,
  ) => Promise<readonly MentionCandidate[]>;
  /** Fires on Cmd/Ctrl + Enter. */
  onSubmit?: () => void;
  disabled?: boolean;
  readOnly?: boolean;
  invalid?: boolean;
  autoFocus?: boolean;
  className?: string;
  editorClassName?: string;
  id?: string;
  /** Hidden input carrying the HTML, for native form posts. */
  name?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  onFocus?: () => void;
  onBlur?: () => void;
}

const DEFAULT_RICH_COMMANDS: readonly RichTextCommand[] = [
  "bold",
  "italic",
  "underline",
  "bulletList",
  "orderedList",
  "link",
];

function OrderedListGlyph({ size = 15 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      <path d="M10 6h11M10 12h11M10 18h11" />
      <path d="M4 4h1v4M4 8h2" />
      <path d="M4 14h2v2H4v2h2" />
    </svg>
  );
}

const RICH_TOOLBAR_BUTTON =
  "grid size-7 place-items-center rounded-md text-content-muted transition-colors " +
  "hover:bg-surface-hover hover:text-content data-[on=true]:bg-accent-subtle " +
  "data-[on=true]:text-accent-subtle-fg disabled:pointer-events-none disabled:opacity-40";

/**
 * A deliberately small contenteditable editor: bold, italic, underline,
 * lists, links and mentions, with no editor framework behind it.
 *
 *   <RichTextEditor value={html} onChange={setHtml}
 *                   loadMentions={(q, s) => api.searchUsers(q, s)} />
 */
export const RichTextEditor = forwardRef<RichTextEditorHandle, RichTextEditorProps>(
  function RichTextEditor(
    {
      value,
      defaultValue = "",
      onChange,
      placeholder = "Write something…",
      toolbar = true,
      minRows = 4,
      maxRows = 16,
      mentionTrigger = "@",
      mentions,
      loadMentions,
      onSubmit,
      disabled = false,
      readOnly = false,
      invalid = false,
      autoFocus,
      className,
      editorClassName,
      id,
      name,
      "aria-label": ariaLabel,
      "aria-labelledby": ariaLabelledBy,
      "aria-describedby": ariaDescribedBy,
      onFocus,
      onBlur,
    },
    ref,
  ) {
    const fieldId = useIsomorphicId(id);
    const mentionListId = `${fieldId}-mentions`;
    const editorRef = useRef<HTMLDivElement | null>(null);
    const caretMarkerRef = useRef<HTMLSpanElement | null>(null);
    const lastEmittedRef = useRef<string>(value ?? defaultValue);
    const savedRangeRef = useRef<Range | null>(null);
    const [html, setHtml] = useState<string>(value ?? defaultValue);
    const [active, setActive] = useState<Record<string, boolean>>({});
    const [empty, setEmpty] = useState(true);
    const [linkOpen, setLinkOpen] = useState(false);
    const [linkUrl, setLinkUrl] = useState("");
    const [mentionQuery, setMentionQuery] = useState<string | null>(null);
    const [mentionIndex, setMentionIndex] = useState(0);
    const [caretAnchor, setCaretAnchor] = useState<HTMLElement | null>(null);
    const emitChange = useEvent(onChange);
    const emitSubmit = useEvent(onSubmit);
    const editable = !disabled && !readOnly;

    const commands =
      toolbar === false ? [] : toolbar === true ? DEFAULT_RICH_COMMANDS : toolbar;

    const mentionAsync = useAsyncOptions(
      loadMentions,
      mentionQuery ?? "",
      mentionQuery !== null && Boolean(loadMentions),
      180,
    );

    const mentionResults = useMemo(() => {
      if (mentionQuery === null) return [];
      if (loadMentions) return mentionAsync.options.slice(0, 8);
      const query = normalise(mentionQuery);
      return (mentions ?? [])
        .filter((candidate) => !query || normalise(candidate.label).includes(query))
        .slice(0, 8);
    }, [loadMentions, mentionAsync.options, mentionQuery, mentions]);

    const emit = useCallback(() => {
      const node = editorRef.current;
      if (!node) return;
      const raw = node.innerHTML;
      const clean = sanitizeRichText(raw);
      lastEmittedRef.current = clean;
      setHtml(clean);
      const text = node.innerText.replace(/\u00a0/g, " ").trim();
      setEmpty(text.length === 0);
      const mentionIds = Array.from(node.querySelectorAll("[data-mention-id]")).map(
        (element) => element.getAttribute("data-mention-id") ?? "",
      );
      emitChange(clean, { text, mentions: mentionIds.filter(Boolean) });
    }, [emitChange]);

    /* Controlled: only write back when the incoming value is not our own. */
    useEffect(() => {
      if (value === undefined) return;
      const node = editorRef.current;
      if (!node) return;
      if (value === lastEmittedRef.current) return;
      const clean = sanitizeRichText(value);
      node.innerHTML = clean;
      lastEmittedRef.current = clean;
      setHtml(clean);
      setEmpty(node.innerText.trim().length === 0);
    }, [value]);

    useEffect(() => {
      const node = editorRef.current;
      if (!node) return;
      node.innerHTML = sanitizeRichText(value ?? defaultValue);
      setEmpty(node.innerText.trim().length === 0);
      // Mount only: later writes go through the controlled effect above.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const refreshActive = useCallback(() => {
      if (typeof document === "undefined") return;
      const node = editorRef.current;
      if (!node || !node.contains(document.getSelection()?.anchorNode ?? null)) return;
      const state = (command: string) => {
        try {
          return document.queryCommandState(command);
        } catch {
          return false;
        }
      };
      setActive({
        bold: state("bold"),
        italic: state("italic"),
        underline: state("underline"),
        strike: state("strikeThrough"),
        bulletList: state("insertUnorderedList"),
        orderedList: state("insertOrderedList"),
      });
    }, []);

    useEffect(() => {
      document.addEventListener("selectionchange", refreshActive);
      return () => document.removeEventListener("selectionchange", refreshActive);
    }, [refreshActive]);

    const exec = useCallback(
      (command: string, argument?: string) => {
        if (!editable) return;
        editorRef.current?.focus();
        try {
          document.execCommand(command, false, argument);
        } catch {
          /* Legacy API — a failure just means the command is unavailable. */
        }
        refreshActive();
        emit();
      },
      [editable, emit, refreshActive],
    );

    /* --- mentions ------------------------------------------------------- */

    const positionCaretMarker = useCallback(() => {
      const selection = document.getSelection();
      const wrap = editorRef.current?.parentElement;
      const marker = caretMarkerRef.current;
      if (!selection || selection.rangeCount === 0 || !wrap || !marker) return;
      const range = selection.getRangeAt(0).cloneRange();
      range.collapse(true);
      const rects = range.getClientRects();
      const rect = rects.length > 0 ? rects[0] : range.getBoundingClientRect();
      if (!rect) return;
      const host = wrap.getBoundingClientRect();
      marker.style.left = `${rect.left - host.left}px`;
      marker.style.top = `${rect.top - host.top}px`;
      marker.style.height = `${Math.max(14, rect.height)}px`;
      setCaretAnchor(marker);
    }, []);

    const detectMention = useCallback(() => {
      if (!mentionTrigger) return;
      const selection = document.getSelection();
      if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) {
        setMentionQuery(null);
        return;
      }
      const range = selection.getRangeAt(0);
      const node = range.startContainer;
      if (node.nodeType !== Node.TEXT_NODE) {
        setMentionQuery(null);
        return;
      }
      const before = (node.textContent ?? "").slice(0, range.startOffset);
      const escaped = mentionTrigger.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = new RegExp(`(?:^|\\s)${escaped}([\\p{L}\\p{N}._-]{0,32})$`, "u").exec(
        before,
      );
      if (!match) {
        setMentionQuery(null);
        return;
      }
      setMentionQuery(match[1] ?? "");
      setMentionIndex(0);
      positionCaretMarker();
    }, [mentionTrigger, positionCaretMarker]);

    const insertMention = useCallback(
      (candidate: MentionCandidate) => {
        const selection = document.getSelection();
        if (!selection || selection.rangeCount === 0) return;
        const range = selection.getRangeAt(0);
        const node = range.startContainer;
        const queryLength = (mentionQuery ?? "").length + mentionTrigger.length;
        if (node.nodeType === Node.TEXT_NODE) {
          const start = Math.max(0, range.startOffset - queryLength);
          range.setStart(node, start);
          range.deleteContents();
        }

        const chip = document.createElement("span");
        chip.setAttribute("data-mention-id", candidate.id);
        chip.setAttribute("data-mention", candidate.label);
        chip.className =
          "rounded px-1 py-px bg-accent-subtle text-accent-subtle-fg font-medium";
        chip.textContent = `${mentionTrigger}${candidate.label}`;
        range.insertNode(chip);

        const spacer = document.createTextNode(" ");
        chip.after(spacer);
        const after = document.createRange();
        after.setStartAfter(spacer);
        after.collapse(true);
        selection.removeAllRanges();
        selection.addRange(after);

        setMentionQuery(null);
        emit();
      },
      [emit, mentionQuery, mentionTrigger],
    );

    /* --- links ---------------------------------------------------------- */

    const openLinkBar = useCallback(() => {
      const selection = document.getSelection();
      if (selection && selection.rangeCount > 0) {
        savedRangeRef.current = selection.getRangeAt(0).cloneRange();
      }
      setLinkUrl("");
      setLinkOpen(true);
    }, []);

    const applyLink = useCallback(() => {
      const url = linkUrl.trim();
      setLinkOpen(false);
      if (!url) return;
      const href = SAFE_HREF.test(url) ? url : `https://${url}`;
      const selection = document.getSelection();
      const saved = savedRangeRef.current;
      if (selection && saved) {
        selection.removeAllRanges();
        selection.addRange(saved);
      }
      editorRef.current?.focus();
      if (saved && saved.collapsed) {
        document.execCommand("insertHTML", false, "");
        const anchor = document.createElement("a");
        anchor.href = href;
        anchor.textContent = href;
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer nofollow";
        saved.insertNode(anchor);
      } else {
        exec("createLink", href);
      }
      emit();
    }, [emit, exec, linkUrl]);

    useImperativeHandle(
      ref,
      () => ({
        focus: () => editorRef.current?.focus(),
        clear: () => {
          if (editorRef.current) editorRef.current.innerHTML = "";
          emit();
        },
        getHTML: () => sanitizeRichText(editorRef.current?.innerHTML ?? ""),
        getText: () => editorRef.current?.innerText ?? "",
        insert: (text: string) => {
          editorRef.current?.focus();
          document.execCommand("insertText", false, text);
          emit();
        },
      }),
      [emit],
    );

    const runCommand = (command: RichTextCommand) => {
      switch (command) {
        case "bold":
          exec("bold");
          break;
        case "italic":
          exec("italic");
          break;
        case "underline":
          exec("underline");
          break;
        case "strike":
          exec("strikeThrough");
          break;
        case "bulletList":
          exec("insertUnorderedList");
          break;
        case "orderedList":
          exec("insertOrderedList");
          break;
        case "code":
          exec("formatBlock", "PRE");
          break;
        case "link":
          openLinkBar();
          break;
        default:
          break;
      }
    };

    const toolbarButton = (command: RichTextCommand) => {
      const shared = {
        type: "button" as const,
        disabled: !editable,
        "data-on": active[command] ? "true" : "false",
        onMouseDown: (event: ReactMouseEvent<HTMLButtonElement>) => event.preventDefault(),
        onClick: () => runCommand(command),
        className: RICH_TOOLBAR_BUTTON,
      };
      switch (command) {
        case "bold":
          return (
            <button key={command} {...shared} aria-label="Bold" title="Bold (⌘B)" aria-pressed={active.bold}>
              <span className="text-body font-bold leading-none">B</span>
            </button>
          );
        case "italic":
          return (
            <button key={command} {...shared} aria-label="Italic" title="Italic (⌘I)" aria-pressed={active.italic}>
              <span className="font-serif text-body italic leading-none">I</span>
            </button>
          );
        case "underline":
          return (
            <button
              key={command}
              {...shared}
              aria-label="Underline"
              title="Underline (⌘U)"
              aria-pressed={active.underline}
            >
              <span className="text-body leading-none underline underline-offset-2">U</span>
            </button>
          );
        case "strike":
          return (
            <button key={command} {...shared} aria-label="Strikethrough" title="Strikethrough" aria-pressed={active.strike}>
              <span className="text-body leading-none line-through">S</span>
            </button>
          );
        case "bulletList":
          return (
            <button
              key={command}
              {...shared}
              aria-label="Bulleted list"
              title="Bulleted list"
              aria-pressed={active.bulletList}
            >
              <IconListView size={15} />
            </button>
          );
        case "orderedList":
          return (
            <button
              key={command}
              {...shared}
              aria-label="Numbered list"
              title="Numbered list"
              aria-pressed={active.orderedList}
            >
              <OrderedListGlyph />
            </button>
          );
        case "code":
          return (
            <button key={command} {...shared} aria-label="Code block" title="Code block">
              <span className="font-mono text-2xs leading-none">{"</>"}</span>
            </button>
          );
        case "link":
          return (
            <button key={command} {...shared} aria-label="Insert link" title="Insert link (⌘K)">
              <IconLink size={15} />
            </button>
          );
        default:
          return null;
      }
    };

    return (
      <div className={cx("w-full", className)} data-slot="rich-text-editor">
        <div
          className={cx(
            "overflow-hidden rounded-md border bg-surface-raised shadow-e0 transition-colors",
            invalid
              ? "border-danger-border focus-within:border-danger-solid focus-within:ring-3 focus-within:ring-danger-solid/25"
              : "border-border focus-within:border-accent focus-within:ring-3 focus-within:ring-accent/25",
            disabled && "opacity-60",
          )}
        >
          {commands.length > 0 ? (
            <div
              role="toolbar"
              aria-label="Formatting"
              aria-controls={fieldId}
              className="flex flex-wrap items-center gap-0.5 border-b border-border-subtle bg-surface-sunken/60 px-1.5 py-1"
            >
              {commands.map((command) => toolbarButton(command))}
            </div>
          ) : null}

          {linkOpen ? (
            <div className="flex items-center gap-1.5 border-b border-border-subtle bg-surface-sunken/40 px-2 py-1.5">
              <IconLink size={13} className="shrink-0 text-content-subtle" />
              <input
                autoFocus
                type="url"
                value={linkUrl}
                placeholder="https://…"
                aria-label="Link URL"
                onChange={(event) => setLinkUrl(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    applyLink();
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    setLinkOpen(false);
                  }
                }}
                className={cx(BARE_INPUT, "h-6 text-body")}
              />
              <Button size="xs" variant="secondary" onClick={applyLink}>
                Apply
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setLinkOpen(false)}>
                Cancel
              </Button>
            </div>
          ) : null}

          <div className="relative">
            <span
              ref={caretMarkerRef}
              aria-hidden="true"
              className="pointer-events-none absolute left-0 top-0 w-px"
              style={{ height: 16 }}
            />
            {empty ? (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-2.5 text-body text-content-subtle"
              >
                {placeholder}
              </span>
            ) : null}
            <div
              ref={editorRef}
              id={fieldId}
              role="textbox"
              aria-multiline="true"
              aria-label={ariaLabel}
              aria-labelledby={ariaLabelledBy}
              aria-describedby={ariaDescribedBy}
              aria-invalid={invalid || undefined}
              aria-disabled={disabled || undefined}
              aria-readonly={readOnly || undefined}
              aria-expanded={mentionQuery !== null}
              aria-controls={mentionQuery !== null ? mentionListId : undefined}
              contentEditable={editable}
              suppressContentEditableWarning
              spellCheck
              data-placeholder={placeholder}
              autoFocus={autoFocus}
              onInput={() => {
                emit();
                detectMention();
              }}
              onFocus={onFocus}
              onBlur={() => {
                setMentionQuery(null);
                emit();
                onBlur?.();
              }}
              onPaste={(event: ReactClipboardEvent<HTMLDivElement>) => {
                event.preventDefault();
                const htmlPayload = event.clipboardData.getData("text/html");
                const textPayload = event.clipboardData.getData("text/plain");
                if (htmlPayload) {
                  document.execCommand("insertHTML", false, sanitizeRichText(htmlPayload));
                } else {
                  document.execCommand("insertText", false, textPayload);
                }
                emit();
              }}
              onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => {
                const meta = event.metaKey || event.ctrlKey;
                if (mentionQuery !== null && mentionResults.length > 0) {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setMentionIndex((index) =>
                      Math.min(mentionResults.length - 1, index + 1),
                    );
                    return;
                  }
                  if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setMentionIndex((index) => Math.max(0, index - 1));
                    return;
                  }
                  if (event.key === "Enter" || event.key === "Tab") {
                    const candidate = mentionResults[mentionIndex];
                    if (candidate) {
                      event.preventDefault();
                      insertMention(candidate);
                      return;
                    }
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    setMentionQuery(null);
                    return;
                  }
                }
                if (meta && event.key === "Enter") {
                  event.preventDefault();
                  emitSubmit();
                  return;
                }
                if (!meta) return;
                const key = event.key.toLowerCase();
                if (key === "b") {
                  event.preventDefault();
                  exec("bold");
                } else if (key === "i") {
                  event.preventDefault();
                  exec("italic");
                } else if (key === "u") {
                  event.preventDefault();
                  exec("underline");
                } else if (key === "k") {
                  event.preventDefault();
                  openLinkBar();
                }
              }}
              style={{
                minHeight: `${minRows * 1.5}rem`,
                maxHeight: `${maxRows * 1.5}rem`,
              }}
              className={cx(
                "w-full overflow-y-auto px-3 py-2.5 text-body text-content outline-none",
                "[&_a]:text-accent-text [&_a]:underline [&_a]:underline-offset-2",
                "[&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5",
                "[&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5",
                "[&_li]:my-0.5",
                "[&_pre]:my-1 [&_pre]:rounded [&_pre]:bg-code-bg [&_pre]:px-2 [&_pre]:py-1.5",
                "[&_pre]:font-mono [&_pre]:text-code",
                "[&_blockquote]:my-1 [&_blockquote]:border-l-2 [&_blockquote]:border-border-strong",
                "[&_blockquote]:pl-3 [&_blockquote]:text-content-muted",
                editorClassName,
              )}
            />
          </div>
        </div>

        {name ? <input type="hidden" name={name} value={html} /> : null}

        <AnchoredPanel
          open={mentionQuery !== null && mentionResults.length > 0}
          onOpenChange={(next) => {
            if (!next) setMentionQuery(null);
          }}
          anchor={caretAnchor}
          maxHeight={240}
          id={mentionListId}
          role="listbox"
          ariaLabel="Mention someone"
          width={280}
        >
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5">
            {mentionResults.map((candidate, index) => (
              <div
                key={candidate.id}
                id={`${mentionListId}-m${index}`}
                role="option"
                aria-selected={index === mentionIndex}
                data-active={index === mentionIndex}
                onMouseEnter={() => setMentionIndex(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => insertMention(candidate)}
                className={OPTION_ROW}
              >
                <Avatar name={candidate.label} src={candidate.avatarUrl ?? undefined} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">
                    {highlightMatch(candidate.label, mentionQuery ?? "")}
                  </span>
                  {candidate.description ? (
                    <span className="mt-0.5 block truncate text-meta text-content-subtle">
                      {candidate.description}
                    </span>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
        </AnchoredPanel>
      </div>
    );
  },
);

/* ==========================================================================
   Form layout
   ========================================================================== */

const GRID_COLUMNS: Record<number, string> = {
  1: "grid-cols-1",
  2: "grid-cols-1 sm:grid-cols-2",
  3: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
  4: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-4",
  6: "grid-cols-2 sm:grid-cols-3 lg:grid-cols-6",
  12: "grid-cols-4 sm:grid-cols-6 lg:grid-cols-12",
};

export interface FormRowProps {
  children: ReactNode;
  /** Columns at the large breakpoint. Collapses to one column on mobile. */
  columns?: 1 | 2 | 3 | 4 | 6 | 12;
  /** Explicit `grid-template-columns`, overriding `columns`. */
  template?: string;
  gap?: "sm" | "md" | "lg";
  align?: "start" | "center" | "end" | "stretch";
  className?: string;
}

/** A responsive grid row for fields. Children are the grid cells. */
export function FormRow({
  children,
  columns = 2,
  template,
  gap = "md",
  align = "start",
  className,
}: FormRowProps) {
  return (
    <div
      data-slot="form-row"
      style={template ? { gridTemplateColumns: template } : undefined}
      className={cx(
        "grid w-full",
        template ? undefined : (GRID_COLUMNS[columns] ?? GRID_COLUMNS[2]),
        gap === "sm" ? "gap-2" : gap === "lg" ? "gap-5" : "gap-stack",
        align === "center"
          ? "items-center"
          : align === "end"
            ? "items-end"
            : align === "stretch"
              ? "items-stretch"
              : "items-start",
        className,
      )}
    >
      {children}
    </div>
  );
}

export interface FormSectionProps {
  title?: ReactNode;
  description?: ReactNode;
  icon?: IconLike;
  /** Right-aligned header slot. */
  actions?: ReactNode;
  children: ReactNode;
  /** Grid columns applied to the section body. Default 1 (stacked). */
  columns?: 1 | 2 | 3 | 4;
  /** Draw a card around the section. Default `false`. */
  bordered?: boolean;
  collapsible?: boolean;
  defaultCollapsed?: boolean;
  className?: string;
  contentClassName?: string;
  id?: string;
}

/** A titled block of fields. The workhorse of every form page. */
export function FormSection({
  title,
  description,
  icon,
  actions,
  children,
  columns = 1,
  bordered = false,
  collapsible = false,
  defaultCollapsed = false,
  className,
  contentClassName,
  id,
}: FormSectionProps) {
  const sectionId = useIsomorphicId(id);
  const bodyId = `${sectionId}-body`;
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const isCollapsed = collapsible && collapsed;

  const header =
    title !== undefined || description !== undefined || actions !== undefined ? (
      <div
        className={cx(
          "flex items-start justify-between gap-3",
          bordered ? "border-b border-border-subtle px-card py-3" : "mb-stack",
        )}
      >
        <div className="flex min-w-0 items-start gap-2">
          {icon ? (
            <span className="mt-0.5 shrink-0 text-content-subtle">{renderIcon(icon, 16)}</span>
          ) : null}
          <div className="min-w-0">
            {title !== undefined ? (
              <h3 className="text-sm font-semibold text-content">{title}</h3>
            ) : null}
            {description !== undefined ? (
              <p className="mt-0.5 max-w-prose text-meta text-content-subtle">{description}</p>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {actions}
          {collapsible ? (
            <button
              type="button"
              aria-expanded={!isCollapsed}
              aria-controls={bodyId}
              onClick={() => setCollapsed((current) => !current)}
              className="grid size-6 place-items-center rounded text-content-subtle hover:bg-surface-hover hover:text-content"
            >
              <IconChevronDown
                size={15}
                className={cx("transition-transform duration-fast", isCollapsed && "-rotate-90")}
              />
            </button>
          ) : null}
        </div>
      </div>
    ) : null;

  return (
    <section
      id={sectionId}
      data-slot="form-section"
      className={cx(
        bordered && "overflow-hidden rounded-lg border border-border bg-surface-raised shadow-e0",
        className,
      )}
    >
      {header}
      <div
        id={bodyId}
        hidden={isCollapsed}
        className={cx(
          columns > 1 ? cx("grid", GRID_COLUMNS[columns], "gap-stack") : "space-y-stack",
          bordered && "px-card py-card",
          contentClassName,
        )}
      >
        {children}
      </div>
    </section>
  );
}

export interface FormActionsProps {
  children: ReactNode;
  align?: "start" | "end" | "between";
  /** Pin to the bottom of the scroll container with a hairline and a blur. */
  sticky?: boolean;
  /** Show the "Unsaved changes" marker on the left. */
  dirty?: boolean;
  dirtyLabel?: ReactNode;
  /** Secondary content on the left (an error summary, a timestamp). */
  info?: ReactNode;
  className?: string;
}

/** The button row at the foot of a form. */
export function FormActions({
  children,
  align = "end",
  sticky = false,
  dirty = false,
  dirtyLabel = "Unsaved changes",
  info,
  className,
}: FormActionsProps) {
  return (
    <div
      data-slot="form-actions"
      className={cx(
        "flex flex-wrap items-center gap-2 pt-stack",
        align === "between"
          ? "justify-between"
          : align === "start"
            ? "justify-start"
            : "justify-end",
        sticky &&
          cx(
            "sticky bottom-0 -mx-page-x mt-section border-t border-border px-page-x py-3",
            "bg-surface/85 supports-[backdrop-filter]:backdrop-blur-xl",
            Z_CLASS.sticky,
          ),
        className,
      )}
    >
      {dirty || info ? (
        <span className="mr-auto flex items-center gap-1.5 text-meta text-content-subtle">
          {dirty ? (
            <>
              <span
                className="size-1.5 shrink-0 rounded-full bg-warning-solid"
                aria-hidden="true"
              />
              <span>{dirtyLabel}</span>
            </>
          ) : null}
          {info}
        </span>
      ) : null}
      {children}
    </div>
  );
}

/* ==========================================================================
   useFormState
   ========================================================================== */

export type FormErrors<T> = Partial<Record<keyof T & string, string>>;
export type FormTouched<T> = Partial<Record<keyof T & string, boolean>>;

type NativeChange = ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>;

/**
 * Everything a control needs, ready to spread:
 *
 *     <Input {...form.field("title")} />
 *
 * Deliberately no `error` key — `InputProps.error` is a boolean, so a message
 * under that name would break every spread. Read the message from
 * `errorMessage` (or `form.fieldError(key)`) and hand it to `<Field error>`.
 */
export interface FieldBinding<V> {
  name: string;
  id: string;
  value: V;
  /** Accepts a raw value (our controlled inputs) or a native change event. */
  onChange: (next: V | NativeChange) => void;
  onBlur: () => void;
  invalid: boolean;
  /** The message to show, once the field has been touched or submitted. */
  errorMessage?: string;
}

export interface FormHelpers<T extends Record<string, unknown>> {
  setErrors: (errors: FormErrors<T>) => void;
  setValues: (patch: Partial<T>) => void;
  reset: (next?: Partial<T>) => void;
  /** Adopt the current values as the new clean baseline. */
  markClean: () => void;
}

export interface UseFormStateOptions<T extends Record<string, unknown>> {
  initialValues: T;
  /** Whole-form validation. Return a map of field → message. */
  validate?: (values: T) => FormErrors<T> | void;
  /** Per-field validation, merged over `validate`'s result. */
  fieldValidators?: Partial<{
    [K in keyof T & string]: (value: T[K], values: T) => string | null | undefined;
  }>;
  onSubmit?: (values: T, helpers: FormHelpers<T>) => void | Promise<void>;
  /** Re-validate on every keystroke. Default `false` (validate on blur). */
  validateOnChange?: boolean;
  /** Validate a field when it loses focus. Default `true`. */
  validateOnBlur?: boolean;
  /** Warn before unload while dirty. Default `true`. */
  guardUnsavedChanges?: boolean;
  /**
   * Adopt a new `initialValues` when it arrives (an async load resolving).
   * Only applied while the form is clean, so in-flight edits are never lost.
   * Default `true`.
   */
  enableReinitialize?: boolean;
  /** Clear the dirty flag after a successful submit. Default `true`. */
  markCleanOnSubmit?: boolean;
  /** Prefix for generated field ids. */
  idPrefix?: string;
}

export interface UseFormStateReturn<T extends Record<string, unknown>> {
  values: T;
  initialValues: T;
  errors: FormErrors<T>;
  touched: FormTouched<T>;
  /** Any field differs from the baseline. */
  dirty: boolean;
  /** The keys that differ. */
  dirtyFields: Array<keyof T & string>;
  isValid: boolean;
  isSubmitting: boolean;
  submitCount: number;

  setValue: <K extends keyof T & string>(key: K, value: T[K]) => void;
  setValues: (patch: Partial<T>) => void;
  setError: (key: keyof T & string, message: string | null) => void;
  setErrors: (errors: FormErrors<T>) => void;
  clearErrors: () => void;
  setTouched: (key: keyof T & string, touched?: boolean) => void;
  touchAll: () => void;

  /** Bind a field to any control in this module. */
  field: <K extends keyof T & string>(key: K) => FieldBinding<T[K]>;
  /** The message for a field, but only once it has been touched or submitted. */
  fieldError: (key: keyof T & string) => string | undefined;
  /** Just the change handler, when `field()` is more than you need. */
  handleChange: <K extends keyof T & string>(key: K) => (next: T[K] | NativeChange) => void;
  handleBlur: (key: keyof T & string) => () => void;

  validateForm: () => FormErrors<T>;
  reset: (next?: Partial<T>) => void;
  markClean: () => void;
  submit: () => Promise<void>;
  /** Spread onto a `<form>`. */
  formProps: {
    onSubmit: (event: FormEvent<HTMLFormElement>) => void;
    noValidate: true;
  };
}

/** Structural equality that understands Dates, arrays and plain objects. */
function valuesEqual(a: unknown, b: unknown, depth = 0): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (depth > 4) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, index) => valuesEqual(item, b[index], depth + 1));
  }
  if (
    typeof a === "object" &&
    typeof b === "object" &&
    a !== null &&
    b !== null &&
    Object.getPrototypeOf(a) === Object.prototype &&
    Object.getPrototypeOf(b) === Object.prototype
  ) {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const keys = Object.keys(left);
    if (keys.length !== Object.keys(right).length) return false;
    return keys.every((key) => valuesEqual(left[key], right[key], depth + 1));
  }
  return false;
}

function isNativeChange(value: unknown): value is NativeChange {
  return (
    typeof value === "object" &&
    value !== null &&
    "target" in value &&
    "nativeEvent" in value
  );
}

function readNativeValue(event: NativeChange): unknown {
  const target = event.target;
  if (target instanceof HTMLInputElement) {
    if (target.type === "checkbox") return target.checked;
    if (target.type === "number") return target.value === "" ? null : target.valueAsNumber;
  }
  return target.value;
}

/**
 * Warn before the tab closes while there are unsaved changes.
 *
 * This is the only guard the platform actually gives us: `BrowserRouter` (as
 * used by this app) has no navigation blocker, so in-app navigation guarding
 * is the caller's job — read `dirty` and confirm before you route away.
 */
export function useUnsavedChangesWarning(when: boolean, message?: string): void {
  useEffect(() => {
    if (!when) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      /* Legacy browsers still read returnValue; modern ones ignore the text. */
      event.returnValue = message ?? "";
      return message ?? "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [message, when]);
}

/**
 * Form state with dirty tracking, validation and an unsaved-changes guard.
 *
 *   const form = useFormState({
 *     initialValues: { title: "", dueOn: null as Date | null, cost: 0 },
 *     fieldValidators: { title: (v) => (v ? null : "Required") },
 *     onSubmit: async (values) => api.saveRfi(values),
 *   });
 *
 *   <form {...form.formProps}>
 *     <Field label="Title" error={form.fieldError("title")}>
 *       <Input {...form.field("title")} />
 *     </Field>
 *     <FormActions dirty={form.dirty}>
 *       <Button type="submit" loading={form.isSubmitting}>Save</Button>
 *     </FormActions>
 *   </form>
 */
export function useFormState<T extends Record<string, unknown>>(
  options: UseFormStateOptions<T>,
): UseFormStateReturn<T> {
  const {
    initialValues,
    validateOnChange = false,
    validateOnBlur = true,
    guardUnsavedChanges = true,
    enableReinitialize = true,
    markCleanOnSubmit = true,
    idPrefix,
  } = options;

  const generatedPrefix = useId();
  const prefix = idPrefix ?? generatedPrefix;
  const [baseline, setBaseline] = useState<T>(initialValues);
  const [values, setValuesState] = useState<T>(initialValues);
  const [errors, setErrorsState] = useState<FormErrors<T>>({});
  const [touched, setTouchedState] = useState<FormTouched<T>>({});
  const [isSubmitting, setSubmitting] = useState(false);
  const [submitCount, setSubmitCount] = useState(0);

  const runValidate = useEvent(options.validate);
  const runSubmit = useEvent(options.onSubmit);
  const fieldValidators = options.fieldValidators;
  const validatorsRef = useRef(fieldValidators);
  validatorsRef.current = fieldValidators;
  const valuesRef = useRef(values);
  valuesRef.current = values;

  const dirtyFields = useMemo(() => {
    const keys = new Set<string>([...Object.keys(baseline), ...Object.keys(values)]);
    return Array.from(keys).filter(
      (key) => !valuesEqual(baseline[key], values[key]),
    ) as Array<keyof T & string>;
  }, [baseline, values]);
  const dirty = dirtyFields.length > 0;

  /* Adopt a late-arriving `initialValues`, but never over live edits. */
  useEffect(() => {
    if (!enableReinitialize) return;
    if (dirty) return;
    if (valuesEqual(baseline, initialValues)) return;
    setBaseline(initialValues);
    setValuesState(initialValues);
    setErrorsState({});
    setTouchedState({});
  }, [baseline, dirty, enableReinitialize, initialValues]);

  useUnsavedChangesWarning(guardUnsavedChanges && dirty);

  const validateForm = useCallback((): FormErrors<T> => {
    const current = valuesRef.current;
    const whole: FormErrors<T> = runValidate(current) ?? {};
    const next: FormErrors<T> = { ...whole };
    const validators = validatorsRef.current;
    if (validators) {
      for (const key of Object.keys(validators) as Array<keyof T & string>) {
        const validator = validators[key];
        if (!validator) continue;
        const message = validator(current[key], current);
        if (message) next[key] = message;
      }
    }
    setErrorsState(next);
    return next;
  }, [runValidate]);

  const validateField = useCallback(
    (key: keyof T & string) => {
      const current = valuesRef.current;
      const whole: FormErrors<T> = runValidate(current) ?? {};
      const validator = validatorsRef.current?.[key];
      const message = validator ? validator(current[key], current) : undefined;
      const resolved = message ?? whole[key];
      setErrorsState((existing) => {
        const next: FormErrors<T> = { ...existing };
        if (resolved) next[key] = resolved;
        else delete next[key];
        return next;
      });
    },
    [runValidate],
  );

  const setValue = useCallback(
    <K extends keyof T & string>(key: K, value: T[K]) => {
      setValuesState((current) => {
        const next = { ...current, [key]: value } as T;
        valuesRef.current = next;
        return next;
      });
      if (validateOnChange) {
        /* Defer so the validator sees the value we just wrote. */
        queueMicrotask(() => validateField(key));
      } else {
        setErrorsState((existing) => {
          if (!existing[key]) return existing;
          const next: FormErrors<T> = { ...existing };
          delete next[key];
          return next;
        });
      }
    },
    [validateField, validateOnChange],
  );

  const setValues = useCallback((patch: Partial<T>) => {
    setValuesState((current) => {
      const next = { ...current, ...patch } as T;
      valuesRef.current = next;
      return next;
    });
  }, []);

  const setError = useCallback((key: keyof T & string, message: string | null) => {
    setErrorsState((current) => {
      const next: FormErrors<T> = { ...current };
      if (message) next[key] = message;
      else delete next[key];
      return next;
    });
  }, []);

  const setTouched = useCallback((key: keyof T & string, isTouched = true) => {
    setTouchedState((current) => ({ ...current, [key]: isTouched }));
  }, []);

  const touchAll = useCallback(() => {
    setTouchedState(() => {
      const next: FormTouched<T> = {};
      for (const key of Object.keys(valuesRef.current) as Array<keyof T & string>) {
        next[key] = true;
      }
      return next;
    });
  }, []);

  const markClean = useCallback(() => {
    setBaseline(valuesRef.current);
  }, []);

  const reset = useCallback(
    (next?: Partial<T>) => {
      const target = { ...baseline, ...(next ?? {}) } as T;
      valuesRef.current = target;
      setValuesState(target);
      setBaseline(target);
      setErrorsState({});
      setTouchedState({});
    },
    [baseline],
  );

  const handleChange = useCallback(
    <K extends keyof T & string>(key: K) =>
      (next: T[K] | NativeChange) => {
        const resolved = isNativeChange(next) ? (readNativeValue(next) as T[K]) : next;
        setValue(key, resolved);
      },
    [setValue],
  );

  const handleBlur = useCallback(
    (key: keyof T & string) => () => {
      setTouched(key, true);
      if (validateOnBlur) validateField(key);
    },
    [setTouched, validateField, validateOnBlur],
  );

  const field = useCallback(
    <K extends keyof T & string>(key: K): FieldBinding<T[K]> => {
      const message = errors[key];
      const wasTouched = Boolean(touched[key]);
      const shown = wasTouched || submitCount > 0;
      return {
        name: key,
        id: `${prefix}-${key}`,
        value: values[key],
        onChange: handleChange(key),
        onBlur: handleBlur(key),
        invalid: Boolean(message) && shown,
        errorMessage: shown ? message : undefined,
      };
    },
    [errors, handleBlur, handleChange, prefix, submitCount, touched, values],
  );

  const fieldError = useCallback(
    (key: keyof T & string) =>
      Boolean(touched[key]) || submitCount > 0 ? errors[key] : undefined,
    [errors, submitCount, touched],
  );

  const helpers = useMemo<FormHelpers<T>>(
    () => ({
      setErrors: setErrorsState,
      setValues,
      reset,
      markClean,
    }),
    [markClean, reset, setValues],
  );

  const submit = useCallback(async () => {
    setSubmitCount((count) => count + 1);
    touchAll();
    const found = validateForm();
    if (Object.keys(found).length > 0) return;
    setSubmitting(true);
    try {
      await runSubmit(valuesRef.current, helpers);
      if (markCleanOnSubmit) setBaseline(valuesRef.current);
    } finally {
      setSubmitting(false);
    }
  }, [helpers, markCleanOnSubmit, runSubmit, touchAll, validateForm]);

  const formProps = useMemo(
    () => ({
      onSubmit: (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        void submit();
      },
      noValidate: true as const,
    }),
    [submit],
  );

  return {
    values,
    initialValues: baseline,
    errors,
    touched,
    dirty,
    dirtyFields,
    isValid: Object.keys(errors).length === 0,
    isSubmitting,
    submitCount,
    setValue,
    setValues,
    setError,
    setErrors: setErrorsState,
    clearErrors: () => setErrorsState({}),
    setTouched,
    touchAll,
    field,
    fieldError,
    handleChange,
    handleBlur,
    validateForm,
    reset,
    markClean,
    submit,
    formProps,
  };
}
