/**
 * primitives.tsx — the core UI vocabulary for ConstructOS.
 *
 * Everything here is built from the semantic tokens in styles.css (via
 * `../ui/tokens`), sized from the density-driven spacing scale, iconed from
 * `../ui/icons`, and composed with `cx`. No component hardcodes a colour, so
 * every one of them is correct in light and dark, comfortable and compact.
 *
 * House rules honoured by every export in this file:
 *   • Keyboard operable. Arrow keys where a widget is a composite.
 *   • A visible focus indicator — usually the global :focus-visible outline;
 *     text fields swap it for a border + halo so the ring hugs the box.
 *   • Correct ARIA roles, names and states.
 *   • Motion is optional: it degrades to a cross-fade under
 *     prefers-reduced-motion (handled globally in styles.css + MotionConfig).
 *
 * BACKWARD COMPATIBILITY: Button, Input, Textarea, Select, Field, Card,
 * CardBody, PageHeader, Table, Th, Td, Badge, statusTone, EmptyState, Spinner,
 * Modal and ErrorAlert keep the exact prop surface ~89k lines of pages already
 * rely on. Props were only ever *added* or *widened*.
 */
import {
  createContext,
  forwardRef,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type Ref,
  type SelectHTMLAttributes,
  type TdHTMLAttributes,
  type TextareaHTMLAttributes,
  type ThHTMLAttributes,
} from "react";
import { cx } from "./cx";
import {
  IconAlert,
  IconArrowDown,
  IconArrowUp,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconChevronUp,
  IconClose,
  IconEmpty,
  IconMinus,
  IconRefresh,
  IconSlash,
  IconSpinner,
  IconUser,
  toneIcon,
  type IconComponent,
} from "./icons";
import {
  TONES,
  deltaToTone,
  directionOf,
  formatStatusLabel,
  fromLegacyBadgeTone,
  statusToLegacyTone,
  statusToTone,
  tone as toneStyles,
  type Direction,
  type LegacyBadgeTone,
  type Tone,
} from "./tokens";

/* ==========================================================================
   Shared vocabulary
   ========================================================================== */

/** The four control heights. Every one is density-aware. */
export type ControlSize = "xs" | "sm" | "md" | "lg";

/** Anything that can stand in for an icon: an icon component or a node. */
export type IconLike = IconComponent | ReactNode;

const CONTROL_H: Record<ControlSize, string> = {
  xs: "h-control-xs",
  sm: "h-control-sm",
  md: "h-control",
  lg: "h-control-lg",
};

const CONTROL_W: Record<ControlSize, string> = {
  xs: "w-control-xs",
  sm: "w-control-sm",
  md: "w-control",
  lg: "w-control-lg",
};

const CONTROL_PX: Record<ControlSize, string> = {
  xs: "px-1.5",
  sm: "px-control-px-sm",
  md: "px-control-px",
  lg: "px-4",
};

const CONTROL_TEXT: Record<ControlSize, string> = {
  xs: "text-2xs",
  sm: "text-xs",
  md: "text-body",
  lg: "text-sm",
};

const CONTROL_GAP: Record<ControlSize, string> = {
  xs: "gap-1",
  sm: "gap-1.5",
  md: "gap-control-gap",
  lg: "gap-2",
};

const CONTROL_RADIUS: Record<ControlSize, string> = {
  xs: "rounded-sm",
  sm: "rounded-md",
  md: "rounded-md",
  lg: "rounded-lg",
};

const CONTROL_ICON_PX: Record<ControlSize, number> = { xs: 12, sm: 14, md: 16, lg: 18 };

/** The shell every text-entry control shares: border, fill, focus halo. */
function fieldShell(size: ControlSize, invalid?: boolean, disabled?: boolean): string {
  return cx(
    "relative flex w-full items-center bg-surface-raised text-content shadow-e0",
    "border transition-[color,background-color,border-color,box-shadow]",
    CONTROL_RADIUS[size],
    CONTROL_TEXT[size],
    invalid
      ? "border-danger-border focus-within:border-danger-solid focus-within:ring-3 focus-within:ring-danger-solid/25"
      : cx(
          "border-border focus-within:border-accent focus-within:ring-3 focus-within:ring-accent/25",
          // Scoped so a hover never out-ranks the focus border: `hover:` and
          // `focus-within:` carry equal specificity and Tailwind emits hover
          // last, which would otherwise erase the accent ring on hover.
          "[&:hover:not(:focus-within)]:border-border-strong",
        ),
    disabled && "cursor-not-allowed opacity-60",
  );
}

/** The bare control that sits inside `fieldShell`. */
const FIELD_CONTROL =
  "peer h-full w-full min-w-0 bg-transparent text-inherit outline-none placeholder:text-content-subtle disabled:cursor-not-allowed";

/* ------------------------------------------------------------------------
   Tone class safelist.

   `tokens.ts` composes its tone recipes with template literals
   (`bg-${family}-subtle`), which Tailwind's source scanner cannot see — so
   without this table `tone.danger.subtle` would resolve to a class that was
   never compiled and every status colour in the product would render blank.

   Listing the literals once here puts them in front of the scanner for the
   whole app (this file is scanned like any other). Keep it in lockstep with
   `ToneStyle` in tokens.ts. It is exported so the value is never tree-shaken.
   ------------------------------------------------------------------------ */
export const TONE_CLASS_SAFELIST: readonly string[] = [
  // neutral
  "bg-neutral-subtle text-neutral-fg bg-neutral-solid text-neutral-on-solid",
  "border-neutral-border ring-neutral-border hover:bg-neutral-subtle",
  // success
  "bg-success-subtle text-success-fg bg-success-solid text-success-on-solid",
  "border-success-border ring-success-border hover:bg-success-subtle",
  // warning
  "bg-warning-subtle text-warning-fg bg-warning-solid text-warning-on-solid",
  "border-warning-border ring-warning-border hover:bg-warning-subtle",
  // danger
  "bg-danger-subtle text-danger-fg bg-danger-solid text-danger-on-solid",
  "border-danger-border ring-danger-border hover:bg-danger-subtle",
  // info
  "bg-info-subtle text-info-fg bg-info-solid text-info-on-solid",
  "border-info-border ring-info-border hover:bg-info-subtle",
  // highlight
  "bg-highlight-subtle text-highlight-fg bg-highlight-solid text-highlight-on-solid",
  "border-highlight-border ring-highlight-border hover:bg-highlight-subtle",
  // accent
  "bg-accent-subtle text-accent-subtle-fg bg-accent text-accent-fg text-accent-text",
  "border-accent-border ring-accent-border hover:bg-accent-subtle-hover",
  // `bar` recipe
  "border-l-2 border-neutral-solid border-success-solid border-warning-solid",
  "border-danger-solid border-info-solid border-highlight-solid border-accent",
];

/* ------------------------------- helpers -------------------------------- */

function isComponentLike(value: unknown): boolean {
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
  const setValue = useCallback(
    (next: T) => {
      if (!isControlled) setUncontrolled(next);
      onChange?.(next);
    },
    [isControlled, onChange],
  );
  return [value, setValue] as const;
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (!ref) return;
  if (typeof ref === "function") ref(value);
  else (ref as { current: T | null }).current = value;
}

/** Stable 32-bit string hash — used for deterministic avatar colours. */
function hashString(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

/** "Nadia Okonkwo-Ferreira" → "NO"; "acme" → "AC". */
export function initialsFrom(name: string | null | undefined): string {
  const clean = (name ?? "").trim();
  if (!clean) return "?";
  const words = clean.split(/[\s._-]+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) {
    const only = words[0] ?? "";
    return only.slice(0, 2).toUpperCase();
  }
  const first = words[0] ?? "";
  const last = words[words.length - 1] ?? "";
  return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase();
}

const TONE_SET = new Set<string>(TONES);

/** Accepts a semantic Tone *or* one of the legacy Badge tone strings. */
export function resolveTone(value: string | null | undefined, fallback: Tone = "neutral"): Tone {
  if (!value) return fallback;
  if (TONE_SET.has(value)) return value as Tone;
  return fromLegacyBadgeTone(value);
}

/** Deterministic per-name chart hue, expressed as theme-aware CSS vars. */
function identityStyle(seed: string): CSSProperties {
  const index = (hashString(seed) % 8) + 1;
  const hue = `var(--ds-chart-${index})`;
  return {
    backgroundColor: `color-mix(in oklab, ${hue} 16%, var(--ds-surface-raised))`,
    color: hue,
    borderColor: `color-mix(in oklab, ${hue} 32%, transparent)`,
  };
}

/** Screen-reader-only text that still gets read and still gets copied. */
export function VisuallyHidden({ children }: { children: ReactNode }) {
  return (
    <span className="absolute h-px w-px overflow-hidden whitespace-nowrap border-0 p-0 [clip:rect(0,0,0,0)]">
      {children}
    </span>
  );
}

/* ==========================================================================
   Button
   ========================================================================== */

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "ghost"
  | "danger"
  | "outline"
  | "link";

export type ButtonSize = ControlSize;

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-accent-fg shadow-e1 hover:bg-accent-hover active:bg-accent-active disabled:hover:bg-accent",
  secondary:
    "bg-surface-raised text-content border border-border shadow-e0 hover:bg-surface-hover hover:border-border-strong active:bg-surface-active disabled:hover:bg-surface-raised",
  outline:
    "bg-transparent text-content border border-border hover:bg-surface-hover hover:border-border-strong active:bg-surface-active",
  ghost:
    "bg-transparent text-content-muted hover:bg-surface-hover hover:text-content active:bg-surface-active",
  danger:
    "bg-danger-solid text-danger-on-solid shadow-e1 hover:bg-danger-solid/90 active:bg-danger-solid/80",
  link: "bg-transparent text-accent-text underline-offset-[3px] hover:underline hover:text-accent-hover",
};

interface ButtonGroupContextValue {
  size?: ButtonSize;
  variant?: ButtonVariant;
  attached: boolean;
}

const ButtonGroupContext = createContext<ButtonGroupContextValue | null>(null);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual weight. Default `primary`. */
  variant?: ButtonVariant;
  /** Control height, from the density scale. Default `md`. */
  size?: ButtonSize;
  /** Swap the label for a centred spinner and block interaction. */
  loading?: boolean;
  /** Shown *instead of* children while loading (keeps the label meaningful). */
  loadingText?: ReactNode;
  /** Leading icon — an icon component or a node. */
  leadingIcon?: IconLike;
  /** Shorthand alias for `leadingIcon`. */
  icon?: IconLike;
  /** Trailing icon — an icon component or a node. */
  trailingIcon?: IconLike;
  /** Square button with no label. Requires `aria-label`. */
  iconOnly?: boolean;
  /** Stretch to the container width. */
  fullWidth?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant,
    size,
    loading = false,
    loadingText,
    leadingIcon,
    icon,
    trailingIcon,
    iconOnly = false,
    fullWidth = false,
    className,
    type,
    disabled,
    children,
    ...rest
  },
  ref,
) {
  const group = useContext(ButtonGroupContext);
  const resolvedVariant: ButtonVariant = variant ?? group?.variant ?? "primary";
  const resolvedSize: ButtonSize = size ?? group?.size ?? "md";
  const iconPx = CONTROL_ICON_PX[resolvedSize];
  const lead = leadingIcon ?? icon;
  const isLink = resolvedVariant === "link";
  const overlaySpinner = loading && loadingText === undefined;
  const inlineSpinner = loading && loadingText !== undefined;

  return (
    <button
      ref={ref}
      type={type ?? "button"}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      data-variant={resolvedVariant}
      data-size={resolvedSize}
      data-loading={loading ? "" : undefined}
      className={cx(
        "relative isolate inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap font-medium",
        "transition-[color,background-color,border-color,box-shadow,transform] duration-fast ease-standard",
        "disabled:cursor-not-allowed disabled:opacity-55 disabled:shadow-none",
        !isLink && "motion-safe:active:scale-[0.985]",
        isLink
          ? "h-auto p-0 text-inherit"
          : cx(
              CONTROL_H[resolvedSize],
              CONTROL_RADIUS[resolvedSize],
              CONTROL_TEXT[resolvedSize],
              CONTROL_GAP[resolvedSize],
              iconOnly ? cx(CONTROL_W[resolvedSize], "px-0") : CONTROL_PX[resolvedSize],
            ),
        BUTTON_VARIANT[resolvedVariant],
        fullWidth && "w-full",
        className,
      )}
      {...rest}
    >
      {overlaySpinner ? (
        <span className="absolute inset-0 grid place-items-center" aria-hidden="true">
          <IconSpinner size={iconPx} />
        </span>
      ) : null}
      <span
        className={cx(
          "inline-flex min-w-0 items-center justify-center",
          CONTROL_GAP[resolvedSize],
          overlaySpinner && "invisible",
        )}
      >
        {inlineSpinner ? (
          <IconSpinner size={iconPx} />
        ) : (
          renderIcon(lead, iconPx, "shrink-0")
        )}
        {iconOnly ? null : (
          <span className="truncate">{inlineSpinner ? loadingText : children}</span>
        )}
        {iconOnly || inlineSpinner ? null : renderIcon(trailingIcon, iconPx, "shrink-0")}
      </span>
      {loading ? <VisuallyHidden>Loading</VisuallyHidden> : null}
    </button>
  );
});

/* ------------------------------ IconButton ------------------------------- */

export interface IconButtonProps
  extends Omit<ButtonProps, "iconOnly" | "leadingIcon" | "trailingIcon" | "children" | "fullWidth" | "icon" | "loadingText"> {
  /** The glyph. */
  icon: IconLike;
  /** Accessible name. Also used as the native tooltip unless `title` is set. */
  label: string;
  /** Suppress the native `title` tooltip. */
  hideTitle?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, hideTitle = false, title, variant = "ghost", size = "md", className, ...rest },
  ref,
) {
  return (
    <Button
      ref={ref}
      variant={variant}
      size={size}
      iconOnly
      leadingIcon={icon}
      aria-label={label}
      title={hideTitle ? title : (title ?? label)}
      className={className}
      {...rest}
    />
  );
});

/* ------------------------------ ButtonGroup ------------------------------ */

export interface ButtonGroupProps extends HTMLAttributes<HTMLDivElement> {
  /** Default size applied to every Button inside. */
  size?: ButtonSize;
  /** Default variant applied to every Button inside. */
  variant?: ButtonVariant;
  /** Join the buttons into one seamless control. Default `true`. */
  attached?: boolean;
  /** Accessible name for the group. */
  "aria-label"?: string;
}

export function ButtonGroup({
  size,
  variant,
  attached = true,
  className,
  children,
  ...rest
}: ButtonGroupProps) {
  const context = useMemo<ButtonGroupContextValue>(
    () => ({ size, variant, attached }),
    [size, variant, attached],
  );
  return (
    <ButtonGroupContext.Provider value={context}>
      <div
        role="group"
        className={cx(
          "inline-flex items-center",
          attached
            ? [
                "isolate",
                "[&>*:not(:first-child)]:-ml-px",
                "[&>*:not(:first-child):not(:last-child)]:rounded-none",
                "[&>*:first-child:not(:last-child)]:rounded-r-none",
                "[&>*:last-child:not(:first-child)]:rounded-l-none",
                "[&>*:hover]:z-10 [&>*:focus-visible]:z-10",
              ]
            : "gap-1.5",
          className,
        )}
        {...rest}
      >
        {children}
      </div>
    </ButtonGroupContext.Provider>
  );
}

/* ==========================================================================
   Input
   ========================================================================== */

export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "size" | "prefix"> {
  /** Control height. Default `md`. */
  size?: ControlSize;
  /** Adornment pinned to the left edge (icon component, node, or text). */
  leading?: IconLike;
  /** Adornment pinned to the right edge. */
  trailing?: IconLike;
  /** Paint the error border and set `aria-invalid`. */
  invalid?: boolean;
  /** Alias of `invalid`. */
  error?: boolean;
  /**
   * `className` lands on the outer box — that is the element that carries the
   * border, fill and width, so `<Input className="w-40" />` behaves exactly as
   * it always has.
   */
  className?: string;
  /** Escape hatch for classes that must reach the `<input>` itself. */
  inputClassName?: string;
  /** Wrapper style. */
  style?: CSSProperties;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    size = "md",
    leading,
    trailing,
    invalid,
    error,
    className,
    inputClassName,
    style,
    disabled,
    type = "text",
    ...rest
  },
  ref,
) {
  const isInvalid = Boolean(invalid ?? error);
  const iconPx = CONTROL_ICON_PX[size];
  const pad = size === "xs" ? "px-1.5" : size === "sm" ? "px-2" : "px-2.5";

  return (
    <div
      data-slot="input"
      style={style}
      className={cx(fieldShell(size, isInvalid, disabled), CONTROL_H[size], pad, className)}
    >
      {leading ? (
        <span className="mr-1.5 flex shrink-0 items-center text-content-subtle">
          {renderIcon(leading, iconPx)}
        </span>
      ) : null}
      <input
        ref={ref}
        type={type}
        disabled={disabled}
        aria-invalid={isInvalid || undefined}
        className={cx(FIELD_CONTROL, inputClassName)}
        {...rest}
      />
      {trailing ? (
        <span className="ml-1.5 flex shrink-0 items-center text-content-subtle">
          {renderIcon(trailing, iconPx)}
        </span>
      ) : null}
    </div>
  );
});

/* ==========================================================================
   Textarea
   ========================================================================== */

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Grow with the content instead of scrolling. */
  autoResize?: boolean;
  /** Floor for `autoResize`. Default 2. */
  minRows?: number;
  /** Ceiling for `autoResize` before it starts scrolling. Default 12. */
  maxRows?: number;
  /** Paint the error border and set `aria-invalid`. */
  invalid?: boolean;
  /** Alias of `invalid`. */
  error?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  {
    autoResize = false,
    minRows = 2,
    maxRows = 12,
    invalid,
    error,
    className,
    disabled,
    value,
    onChange,
    ...rest
  },
  ref,
) {
  const isInvalid = Boolean(invalid ?? error);
  const innerRef = useRef<HTMLTextAreaElement | null>(null);

  const setRefs = useCallback(
    (node: HTMLTextAreaElement | null) => {
      innerRef.current = node;
      assignRef(ref, node);
    },
    [ref],
  );

  const resize = useCallback(() => {
    const el = innerRef.current;
    if (!el || !autoResize) return;
    const styles = window.getComputedStyle(el);
    const lineHeight = Number.parseFloat(styles.lineHeight) || 20;
    const vertical =
      Number.parseFloat(styles.paddingTop) +
      Number.parseFloat(styles.paddingBottom) +
      Number.parseFloat(styles.borderTopWidth) +
      Number.parseFloat(styles.borderBottomWidth);
    const min = minRows * lineHeight + vertical;
    const max = maxRows * lineHeight + vertical;
    el.style.height = "auto";
    const next = Math.min(Math.max(el.scrollHeight, min), max);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [autoResize, maxRows, minRows]);

  useLayoutEffect(() => {
    resize();
  }, [resize, value]);

  return (
    <textarea
      ref={setRefs}
      value={value}
      disabled={disabled}
      aria-invalid={isInvalid || undefined}
      onChange={(event) => {
        onChange?.(event);
        if (autoResize) resize();
      }}
      className={cx(
        "block w-full min-h-24 resize-y bg-surface-raised px-2.5 py-1.5 text-body text-content shadow-e0",
        "rounded-md border transition-[color,background-color,border-color,box-shadow]",
        "placeholder:text-content-subtle focus:outline-none",
        isInvalid
          ? "border-danger-border focus:border-danger-solid focus:ring-3 focus:ring-danger-solid/25"
          : cx(
              "border-border focus:border-accent focus:ring-3 focus:ring-accent/25",
              "[&:hover:not(:focus)]:border-border-strong",
            ),
        disabled && "cursor-not-allowed opacity-60",
        autoResize && "resize-none",
        className,
      )}
      {...rest}
    />
  );
});

/* ==========================================================================
   Select — a real <select> for correctness, painted so it never looks native.
   ========================================================================== */

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> {
  /** Control height. Default `md`. */
  size?: ControlSize;
  /** Leading adornment. */
  leading?: IconLike;
  /** Paint the error border and set `aria-invalid`. */
  invalid?: boolean;
  /** Alias of `invalid`. */
  error?: boolean;
  /** Renders a disabled first option when the value is empty. */
  placeholder?: string;
  /** `className` lands on the outer box (border/fill/width). */
  className?: string;
  /** Escape hatch for classes that must reach the `<select>` itself. */
  selectClassName?: string;
  style?: CSSProperties;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  {
    size = "md",
    leading,
    invalid,
    error,
    placeholder,
    className,
    selectClassName,
    style,
    disabled,
    children,
    ...rest
  },
  ref,
) {
  const isInvalid = Boolean(invalid ?? error);
  const iconPx = CONTROL_ICON_PX[size];
  const pad = size === "xs" ? "pl-1.5" : size === "sm" ? "pl-2" : "pl-2.5";

  return (
    <div
      data-slot="select"
      style={style}
      className={cx(fieldShell(size, isInvalid, disabled), CONTROL_H[size], pad, "pr-7", className)}
    >
      {leading ? (
        <span className="mr-1.5 flex shrink-0 items-center text-content-subtle">
          {renderIcon(leading, iconPx)}
        </span>
      ) : null}
      <select
        ref={ref}
        disabled={disabled}
        aria-invalid={isInvalid || undefined}
        className={cx(
          FIELD_CONTROL,
          "cursor-pointer appearance-none truncate pr-0",
          "[&>option]:bg-surface-raised [&>option]:text-content",
          "[&>optgroup]:bg-surface-raised [&>optgroup]:text-content-muted",
          selectClassName,
        )}
        {...rest}
      >
        {placeholder ? (
          <option value="" disabled>
            {placeholder}
          </option>
        ) : null}
        {children}
      </select>
      <IconChevronDown
        size={iconPx}
        className="pointer-events-none absolute right-2 text-content-subtle"
      />
    </div>
  );
});

/* ==========================================================================
   Checkbox / Radio / Switch
   ========================================================================== */

const CHOICE_BOX =
  "peer relative shrink-0 appearance-none border bg-surface-raised transition-[background-color,border-color,box-shadow] " +
  "border-border-strong hover:border-accent " +
  "checked:border-accent checked:bg-accent indeterminate:border-accent indeterminate:bg-accent " +
  "disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:border-border-strong";

export interface CheckboxProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "size" | "type"> {
  /** `sm` = 14px box, `md` = 16px box. Default `md`. */
  size?: "sm" | "md";
  /** Inline label. Renders the whole thing as a `<label>` when present. */
  label?: ReactNode;
  /** Secondary line under the label. */
  description?: ReactNode;
  /** Tri-state. Sets `.indeterminate` on the underlying input. */
  indeterminate?: boolean;
  /** Paint the error border and set `aria-invalid`. */
  invalid?: boolean;
  /** Class for the outer `<label>` / wrapper. */
  className?: string;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  {
    size = "md",
    label,
    description,
    indeterminate = false,
    invalid,
    className,
    disabled,
    id,
    ...rest
  },
  ref,
) {
  const innerRef = useRef<HTMLInputElement | null>(null);
  const autoId = useId();
  const inputId = id ?? `cb-${autoId}`;
  const box = size === "sm" ? "size-3.5" : "size-4";
  const glyph = size === "sm" ? 10 : 12;

  const setRefs = useCallback(
    (node: HTMLInputElement | null) => {
      innerRef.current = node;
      assignRef(ref, node);
    },
    [ref],
  );

  useEffect(() => {
    if (innerRef.current) innerRef.current.indeterminate = indeterminate;
  }, [indeterminate]);

  const control = (
    <span className="relative inline-grid shrink-0 place-items-center">
      <input
        ref={setRefs}
        id={inputId}
        type="checkbox"
        disabled={disabled}
        aria-invalid={invalid || undefined}
        className={cx(CHOICE_BOX, box, "rounded-xs", invalid && "border-danger-border")}
        {...rest}
      />
      <IconCheck
        size={glyph}
        strokeWidth={3}
        className="pointer-events-none absolute text-accent-fg opacity-0 transition-opacity peer-checked:opacity-100 peer-indeterminate:opacity-0"
      />
      <IconMinus
        size={glyph}
        strokeWidth={3}
        className="pointer-events-none absolute text-accent-fg opacity-0 transition-opacity peer-indeterminate:opacity-100"
      />
    </span>
  );

  if (label === undefined && description === undefined) {
    return <span className={cx("inline-flex", className)}>{control}</span>;
  }

  return (
    <label
      htmlFor={inputId}
      className={cx(
        "flex cursor-pointer select-none items-start gap-2",
        disabled && "cursor-not-allowed opacity-60",
        className,
      )}
    >
      <span className="flex h-5 items-center">{control}</span>
      <span className="min-w-0">
        {label !== undefined ? (
          <span className="block text-body text-content">{label}</span>
        ) : null}
        {description !== undefined ? (
          <span className="mt-0.5 block text-meta text-content-subtle">{description}</span>
        ) : null}
      </span>
    </label>
  );
});

export interface RadioProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size" | "type"> {
  size?: "sm" | "md";
  label?: ReactNode;
  description?: ReactNode;
  invalid?: boolean;
  className?: string;
}

export const Radio = forwardRef<HTMLInputElement, RadioProps>(function Radio(
  { size = "md", label, description, invalid, className, disabled, id, ...rest },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? `rb-${autoId}`;
  const box = size === "sm" ? "size-3.5" : "size-4";
  const dot = size === "sm" ? "size-1.5" : "size-[0.4375rem]";

  const control = (
    <span className="relative inline-grid shrink-0 place-items-center">
      <input
        ref={ref}
        id={inputId}
        type="radio"
        disabled={disabled}
        aria-invalid={invalid || undefined}
        className={cx(CHOICE_BOX, box, "rounded-full", invalid && "border-danger-border")}
        {...rest}
      />
      <span
        className={cx(
          "pointer-events-none absolute rounded-full bg-accent-fg opacity-0 transition-opacity peer-checked:opacity-100",
          dot,
        )}
      />
    </span>
  );

  if (label === undefined && description === undefined) {
    return <span className={cx("inline-flex", className)}>{control}</span>;
  }

  return (
    <label
      htmlFor={inputId}
      className={cx(
        "flex cursor-pointer select-none items-start gap-2",
        disabled && "cursor-not-allowed opacity-60",
        className,
      )}
    >
      <span className="flex h-5 items-center">{control}</span>
      <span className="min-w-0">
        {label !== undefined ? (
          <span className="block text-body text-content">{label}</span>
        ) : null}
        {description !== undefined ? (
          <span className="mt-0.5 block text-meta text-content-subtle">{description}</span>
        ) : null}
      </span>
    </label>
  );
});

export interface RadioOption<T extends string = string> {
  value: T;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}

export interface RadioGroupProps<T extends string = string> {
  /** Shared `name`. Auto-generated when omitted. */
  name?: string;
  value?: T;
  defaultValue?: T;
  onChange?: (value: T) => void;
  /** Declarative options. Ignored when `children` is provided. */
  options?: ReadonlyArray<RadioOption<T>>;
  children?: ReactNode;
  orientation?: "vertical" | "horizontal";
  disabled?: boolean;
  size?: "sm" | "md";
  /** Accessible name for the group. */
  label?: ReactNode;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  className?: string;
}

export function RadioGroup<T extends string = string>({
  name,
  value,
  defaultValue,
  onChange,
  options,
  children,
  orientation = "vertical",
  disabled = false,
  size = "md",
  label,
  className,
  ...aria
}: RadioGroupProps<T>) {
  const autoId = useId();
  const groupName = name ?? `rg-${autoId}`;
  const labelId = `${groupName}-label`;
  const [current, setCurrent] = useControllableState<T | undefined>(
    value,
    defaultValue,
    onChange as ((next: T | undefined) => void) | undefined,
  );

  return (
    <div
      role="radiogroup"
      aria-labelledby={label ? labelId : aria["aria-labelledby"]}
      aria-label={label ? undefined : aria["aria-label"]}
      aria-orientation={orientation}
      className={cx(className)}
    >
      {label ? (
        <span id={labelId} className="mb-1.5 block text-label uppercase text-content-subtle">
          {label}
        </span>
      ) : null}
      <div
        className={cx(
          "flex",
          orientation === "vertical" ? "flex-col gap-2" : "flex-row flex-wrap gap-x-4 gap-y-2",
        )}
      >
        {children ??
          options?.map((option) => (
            <Radio
              key={option.value}
              name={groupName}
              size={size}
              value={option.value}
              label={option.label}
              description={option.description}
              disabled={disabled || option.disabled}
              checked={current === option.value}
              onChange={() => setCurrent(option.value)}
            />
          ))}
      </div>
    </div>
  );
}

export interface SwitchProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "value" | "type"> {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  /** Convenience alias of `onCheckedChange`. */
  onChange?: (checked: boolean) => void;
  size?: "sm" | "md";
  label?: ReactNode;
  description?: ReactNode;
  /** Put the label before the switch. */
  labelPosition?: "start" | "end";
  className?: string;
}

export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  {
    checked,
    defaultChecked = false,
    onCheckedChange,
    onChange,
    size = "md",
    label,
    description,
    labelPosition = "end",
    className,
    disabled,
    id,
    ...rest
  },
  ref,
) {
  const autoId = useId();
  const switchId = id ?? `sw-${autoId}`;
  const handle = useCallback(
    (next: boolean) => {
      onCheckedChange?.(next);
      onChange?.(next);
    },
    [onCheckedChange, onChange],
  );
  const [on, setOn] = useControllableState<boolean>(checked, defaultChecked, handle);

  const track = size === "sm" ? "h-4 w-7" : "h-5 w-9";
  const knob = size === "sm" ? "size-3" : "size-4";
  const shift = size === "sm" ? "translate-x-3" : "translate-x-4";

  const control = (
    <button
      ref={ref}
      id={switchId}
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => setOn(!on)}
      className={cx(
        "relative inline-flex shrink-0 cursor-pointer items-center rounded-full border border-transparent p-0.5",
        "transition-colors duration-fast ease-standard",
        on ? "bg-accent" : "bg-neutral-solid/45 hover:bg-neutral-solid/60",
        "disabled:cursor-not-allowed disabled:opacity-50",
        track,
        label === undefined && description === undefined ? className : undefined,
      )}
      {...rest}
    >
      <span
        aria-hidden="true"
        className={cx(
          "pointer-events-none block rounded-full bg-surface-raised shadow-e1 transition-transform duration-fast ease-emphasized",
          knob,
          on ? shift : "translate-x-0",
        )}
      />
    </button>
  );

  if (label === undefined && description === undefined) return control;

  const text = (
    <span className="min-w-0">
      {label !== undefined ? <span className="block text-body text-content">{label}</span> : null}
      {description !== undefined ? (
        <span className="mt-0.5 block text-meta text-content-subtle">{description}</span>
      ) : null}
    </span>
  );

  return (
    <div
      className={cx(
        "flex select-none items-start gap-2.5",
        labelPosition === "start" && "flex-row-reverse justify-between",
        disabled && "opacity-60",
        className,
      )}
    >
      <span className="flex h-5 items-center">{control}</span>
      <label
        htmlFor={switchId}
        className={cx("min-w-0", disabled ? "cursor-not-allowed" : "cursor-pointer")}
      >
        {text}
      </label>
    </div>
  );
});

/* ==========================================================================
   Slider
   ========================================================================== */

export interface SliderProps
  extends Omit<
    InputHTMLAttributes<HTMLInputElement>,
    "size" | "type" | "value" | "defaultValue" | "onChange"
  > {
  value?: number;
  defaultValue?: number;
  onValueChange?: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  size?: "sm" | "md";
  /** Show the current value on the right. */
  showValue?: boolean;
  /** Custom value formatter for `showValue` and the ARIA text. */
  formatValue?: (value: number) => string;
  /** Optional label rendered above the track. */
  label?: ReactNode;
  tone?: Tone;
  className?: string;
}

export const Slider = forwardRef<HTMLInputElement, SliderProps>(function Slider(
  {
    value,
    defaultValue = 0,
    onValueChange,
    min = 0,
    max = 100,
    step = 1,
    size = "md",
    showValue = false,
    formatValue,
    label,
    tone: sliderTone = "accent",
    className,
    disabled,
    id,
    ...rest
  },
  ref,
) {
  const autoId = useId();
  const sliderId = id ?? `sl-${autoId}`;
  const [current, setCurrent] = useControllableState<number>(value, defaultValue, onValueChange);
  const span = max - min || 1;
  const pct = Math.min(100, Math.max(0, ((current - min) / span) * 100));
  const fill =
    sliderTone === "accent" ? "var(--ds-accent)" : `var(--ds-${sliderTone}-solid)`;
  const display = formatValue ? formatValue(current) : String(current);
  const trackH = size === "sm" ? "h-1" : "h-1.5";

  return (
    <div className={cx("w-full", className)}>
      {label !== undefined || showValue ? (
        <div className="mb-1.5 flex items-baseline justify-between gap-2">
          {label !== undefined ? (
            <label htmlFor={sliderId} className="text-meta font-medium text-content-muted">
              {label}
            </label>
          ) : (
            <span />
          )}
          {showValue ? (
            <span className="text-meta tabular-nums text-content">{display}</span>
          ) : null}
        </div>
      ) : null}
      <input
        ref={ref}
        id={sliderId}
        type="range"
        min={min}
        max={max}
        step={step}
        value={current}
        disabled={disabled}
        aria-valuetext={formatValue ? display : undefined}
        onChange={(event) => setCurrent(Number(event.target.value))}
        style={{
          background: `linear-gradient(to right, ${fill} 0%, ${fill} ${pct}%, var(--ds-neutral-subtle) ${pct}%, var(--ds-neutral-subtle) 100%)`,
        }}
        className={cx(
          "w-full cursor-pointer appearance-none rounded-full bg-neutral-subtle outline-offset-4",
          trackH,
          "disabled:cursor-not-allowed disabled:opacity-50",
          // WebKit / Blink
          "[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:size-4",
          "[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2",
          "[&::-webkit-slider-thumb]:border-accent [&::-webkit-slider-thumb]:bg-surface-raised",
          "[&::-webkit-slider-thumb]:shadow-e2 [&::-webkit-slider-thumb]:transition-transform",
          "[&::-webkit-slider-thumb]:hover:scale-110 [&::-webkit-slider-thumb]:active:scale-95",
          // Gecko
          "[&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:rounded-full",
          "[&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-accent",
          "[&::-moz-range-thumb]:bg-surface-raised [&::-moz-range-thumb]:shadow-e2",
          "[&::-moz-range-track]:bg-transparent",
        )}
        {...rest}
      />
    </div>
  );
});

/* ==========================================================================
   Label + Field
   ========================================================================== */

export interface LabelProps extends HTMLAttributes<HTMLLabelElement> {
  htmlFor?: string;
  /** Append the required marker. */
  required?: boolean;
  /** Append a muted "optional". */
  optional?: boolean;
  /** `label` = uppercase micro-label, `field` = sentence-case form label. */
  variant?: "field" | "label";
  size?: "sm" | "md";
  disabled?: boolean;
}

export const Label = forwardRef<HTMLLabelElement, LabelProps>(function Label(
  { required, optional, variant = "field", size = "md", disabled, className, children, ...rest },
  ref,
) {
  return (
    <label
      ref={ref}
      className={cx(
        "inline-flex items-center gap-1 font-medium",
        variant === "label"
          ? "text-label uppercase text-content-subtle"
          : size === "sm"
            ? "text-meta text-content-muted"
            : "text-meta text-content",
        disabled && "opacity-60",
        className,
      )}
      {...rest}
    >
      {children}
      {required ? (
        <span className="text-danger-fg" aria-hidden="true">
          *
        </span>
      ) : null}
      {optional && !required ? (
        <span className="font-normal text-content-subtle">(optional)</span>
      ) : null}
    </label>
  );
});

export interface FieldProps {
  /** Field label. Optional so a Field can wrap an already-labelled control. */
  label?: ReactNode;
  children: ReactNode;
  /** Helper text under the control. Hidden while `error` is showing. */
  hint?: ReactNode;
  /** Validation message. Rendered in the danger tone with `role="alert"`. */
  error?: ReactNode | null;
  /** Show the required marker. */
  required?: boolean;
  /** Show a muted "(optional)". */
  optional?: boolean;
  /** Associate the label with a control by id. Renders a `<div>` wrapper. */
  htmlFor?: string;
  /** Stack the label beside the control instead of above it. */
  layout?: "vertical" | "horizontal";
  /** Label column width in the horizontal layout. Default `w-40`. */
  labelWidth?: string;
  disabled?: boolean;
  className?: string;
  labelClassName?: string;
  /** Right-aligned slot on the label row (e.g. a "Learn more" link). */
  action?: ReactNode;
}

export function Field({
  label,
  children,
  hint,
  error,
  required,
  optional,
  htmlFor,
  layout = "vertical",
  labelWidth = "w-40",
  disabled,
  className,
  labelClassName,
  action,
}: FieldProps) {
  const autoId = useId();
  const hintId = `${autoId}-hint`;
  const errorId = `${autoId}-error`;
  const horizontal = layout === "horizontal";

  const labelNode =
    label !== undefined ? (
      <span
        className={cx(
          "inline-flex items-center gap-1 text-meta font-medium text-content-muted",
          disabled && "opacity-60",
          labelClassName,
        )}
      >
        {label}
        {required ? (
          <span className="text-danger-fg" aria-hidden="true">
            *
          </span>
        ) : null}
        {optional && !required ? (
          <span className="font-normal text-content-subtle">(optional)</span>
        ) : null}
      </span>
    ) : null;

  const messages = (
    <>
      {error ? (
        <span
          id={errorId}
          role="alert"
          className="mt-1 flex items-start gap-1 text-meta text-danger-fg"
        >
          <IconAlert size={12} className="mt-px" />
          <span>{error}</span>
        </span>
      ) : hint !== undefined && hint !== null ? (
        <span id={hintId} className="mt-1 block text-meta text-content-subtle">
          {hint}
        </span>
      ) : null}
    </>
  );

  const body = (
    <>
      <span className={cx("block", horizontal ? "min-w-0 flex-1" : "w-full")}>{children}</span>
      {messages}
    </>
  );

  const header =
    labelNode || action ? (
      <span
        className={cx(
          "flex items-center justify-between gap-2",
          horizontal ? cx("shrink-0 pt-1.5", labelWidth) : "mb-1",
        )}
      >
        {labelNode}
        {action ? <span className="shrink-0">{action}</span> : null}
      </span>
    ) : null;

  const inner = horizontal ? (
    <span className="flex w-full items-start gap-3">
      {header}
      <span className="min-w-0 flex-1">{body}</span>
    </span>
  ) : (
    <>
      {header}
      {body}
    </>
  );

  const wrapperClass = cx("block", disabled && "opacity-60", className);

  if (htmlFor) {
    return (
      <div className={wrapperClass} data-slot="field">
        {horizontal ? (
          <div className="flex w-full items-start gap-3">
            {labelNode || action ? (
              <div className={cx("flex shrink-0 items-center justify-between gap-2 pt-1.5", labelWidth)}>
                {labelNode ? <label htmlFor={htmlFor}>{labelNode}</label> : null}
                {action}
              </div>
            ) : null}
            <div className="min-w-0 flex-1">
              {children}
              {messages}
            </div>
          </div>
        ) : (
          <>
            {labelNode || action ? (
              <div className="mb-1 flex items-center justify-between gap-2">
                {labelNode ? <label htmlFor={htmlFor}>{labelNode}</label> : null}
                {action}
              </div>
            ) : null}
            {children}
            {messages}
          </>
        )}
      </div>
    );
  }

  return (
    <label className={wrapperClass} data-slot="field">
      {inner}
    </label>
  );
}

/* ==========================================================================
   SegmentedControl
   ========================================================================== */

export interface SegmentedOption<T extends string = string> {
  value: T;
  label?: ReactNode;
  icon?: IconLike;
  disabled?: boolean;
  title?: string;
  /** Small count chip on the right of the label. */
  count?: number;
}

export interface SegmentedControlProps<T extends string = string> {
  value: T;
  onChange: (value: T) => void;
  options: ReadonlyArray<SegmentedOption<T>>;
  size?: "xs" | "sm" | "md";
  fullWidth?: boolean;
  /** Accessible name for the control. */
  "aria-label"?: string;
  className?: string;
}

export function SegmentedControl<T extends string = string>({
  value,
  onChange,
  options,
  size = "sm",
  fullWidth = false,
  className,
  ...aria
}: SegmentedControlProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const height = size === "xs" ? "h-control-xs" : size === "sm" ? "h-control-sm" : "h-control";
  const text = size === "md" ? "text-body" : "text-xs";
  const iconPx = size === "md" ? 15 : 13;

  const move = useCallback(
    (from: number, delta: number) => {
      const total = options.length;
      if (total === 0) return;
      let next = from;
      for (let step = 0; step < total; step += 1) {
        next = (next + delta + total) % total;
        const candidate = options[next];
        if (candidate && !candidate.disabled) {
          refs.current[next]?.focus();
          onChange(candidate.value);
          return;
        }
      }
    },
    [onChange, options],
  );

  return (
    <div
      role="radiogroup"
      aria-label={aria["aria-label"]}
      className={cx(
        "inline-flex items-center gap-0.5 rounded-lg border border-border bg-surface-sunken p-0.5",
        fullWidth && "flex w-full",
        className,
      )}
    >
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={option.disabled}
            title={option.title}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                event.preventDefault();
                move(index, 1);
              } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                event.preventDefault();
                move(index, -1);
              } else if (event.key === "Home") {
                event.preventDefault();
                move(-1, 1);
              } else if (event.key === "End") {
                event.preventDefault();
                move(0, -1);
              }
            }}
            className={cx(
              "relative inline-flex min-w-0 shrink-0 items-center justify-center gap-1.5 rounded-md px-2.5 font-medium",
              "transition-[color,background-color,box-shadow] duration-fast ease-standard",
              "disabled:cursor-not-allowed disabled:opacity-45",
              height,
              text,
              fullWidth && "flex-1",
              selected
                ? "bg-surface-raised text-content shadow-e1"
                : "text-content-muted hover:bg-surface-hover hover:text-content",
            )}
          >
            {renderIcon(option.icon, iconPx)}
            {option.label !== undefined ? <span className="truncate">{option.label}</span> : null}
            {option.count !== undefined ? (
              <span
                className={cx(
                  "rounded-full px-1 text-2xs tabular-nums",
                  selected ? "bg-surface-sunken text-content-muted" : "text-content-subtle",
                )}
              >
                {option.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/* ==========================================================================
   Badge / StatusPill / Tag
   ========================================================================== */

export type BadgeVariant = "subtle" | "solid" | "outline";

export interface BadgeProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  /**
   * A semantic Tone ("success", "danger", …) *or* a legacy tone string
   * ("green", "red", "amber", "blue", "violet", "gray", …). Default "gray".
   */
  tone?: Tone | LegacyBadgeTone | string;
  variant?: BadgeVariant;
  size?: "xs" | "sm";
  /** Leading status dot in the tone colour. */
  dot?: boolean;
  /** Leading icon. */
  icon?: IconLike;
  /** Renders a dismiss affordance. */
  onRemove?: () => void;
  /** Accessible label for the dismiss button. */
  removeLabel?: string;
  children?: ReactNode;
}

export function Badge({
  tone: badgeTone = "gray",
  variant = "subtle",
  size = "sm",
  dot = false,
  icon,
  onRemove,
  removeLabel = "Remove",
  className,
  children,
  ...rest
}: BadgeProps) {
  const resolved = resolveTone(badgeTone, "neutral");
  const styles = toneStyles[resolved];
  const glyph = size === "xs" ? 10 : 12;

  return (
    <span
      className={cx(
        "inline-flex max-w-full items-center gap-1 whitespace-nowrap rounded-full border font-medium",
        size === "xs" ? "px-1.5 py-px text-2xs" : "px-2 py-0.5 text-meta",
        variant === "solid"
          ? cx(styles.solid, "border-transparent")
          : variant === "outline"
            ? cx(styles.outline, styles.border)
            : cx(styles.subtle, styles.border),
        className,
      )}
      {...rest}
    >
      {dot ? (
        <span
          aria-hidden="true"
          className={cx(
            "size-1.5 shrink-0 rounded-full",
            variant === "solid" ? "bg-current opacity-80" : styles.dot,
          )}
        />
      ) : null}
      {renderIcon(icon, glyph)}
      <span className="truncate">{children}</span>
      {onRemove ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
          aria-label={removeLabel}
          className="-mr-0.5 ml-0.5 grid size-3.5 shrink-0 place-items-center rounded-full opacity-60 transition-opacity hover:bg-black/10 hover:opacity-100 dark:hover:bg-white/10"
        >
          <IconClose size={10} strokeWidth={2.5} />
        </button>
      ) : null}
    </span>
  );
}

export interface StatusPillProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  /** Raw lifecycle string from the API — mapped to a tone and a Title Case label. */
  status: string | null | undefined;
  /** Override the rendered text. */
  label?: ReactNode;
  /** Override the derived tone. */
  tone?: Tone;
  /** Show the leading dot. Default `true`. */
  dot?: boolean;
  size?: "xs" | "sm";
  variant?: BadgeVariant | "bare";
}

export function StatusPill({
  status,
  label,
  tone: override,
  dot = true,
  size = "sm",
  variant = "subtle",
  className,
  ...rest
}: StatusPillProps) {
  const resolved = override ?? statusToTone(status);
  const text = label ?? formatStatusLabel(status);

  if (variant === "bare") {
    return (
      <span
        className={cx("inline-flex items-center gap-1.5 text-meta text-content", className)}
        {...rest}
      >
        <span
          aria-hidden="true"
          className={cx("size-1.5 shrink-0 rounded-full", toneStyles[resolved].dot)}
        />
        {text}
      </span>
    );
  }

  return (
    <Badge tone={resolved} variant={variant} size={size} dot={dot} className={className} {...rest}>
      {text}
    </Badge>
  );
}

export interface TagProps extends Omit<HTMLAttributes<HTMLSpanElement>, "onClick"> {
  tone?: Tone | LegacyBadgeTone | string;
  size?: "xs" | "sm" | "md";
  icon?: IconLike;
  onRemove?: () => void;
  removeLabel?: string;
  onClick?: () => void;
  /** Render as a pressed/selected filter token. */
  selected?: boolean;
}

export function Tag({
  tone: tagTone = "neutral",
  size = "sm",
  icon,
  onRemove,
  removeLabel = "Remove",
  onClick,
  selected = false,
  className,
  children,
  ...rest
}: TagProps) {
  const resolved = resolveTone(tagTone, "neutral");
  const styles = toneStyles[resolved];
  const glyph = size === "xs" ? 10 : size === "sm" ? 12 : 14;
  const interactive = Boolean(onClick);

  return (
    <span
      className={cx(
        "inline-flex max-w-full items-center gap-1.5 rounded-md border font-medium",
        size === "xs" ? "h-5 px-1.5 text-2xs" : size === "sm" ? "h-6 px-2 text-meta" : "h-7 px-2.5 text-body",
        selected ? cx(styles.subtle, styles.border) : "border-border bg-surface-sunken text-content-muted",
        interactive && "cursor-pointer hover:border-border-strong hover:text-content",
        className,
      )}
      {...(interactive
        ? {
            role: "button",
            tabIndex: 0,
            onClick,
            onKeyDown: (event: ReactKeyboardEvent) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onClick?.();
              }
            },
          }
        : null)}
      {...rest}
    >
      {renderIcon(icon, glyph)}
      <span className="truncate">{children}</span>
      {onRemove ? (
        <button
          type="button"
          aria-label={removeLabel}
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
          className="-mr-1 grid size-4 shrink-0 place-items-center rounded text-content-subtle transition-colors hover:bg-surface-active hover:text-content"
        >
          <IconClose size={11} strokeWidth={2.5} />
        </button>
      ) : null}
    </span>
  );
}

/**
 * Legacy status → legacy Badge tone. Preserved verbatim for the ~250 existing
 * call sites, with the full semantic map as the fallback for anything else.
 */
const LEGACY_STATUS_TONE: Record<string, LegacyBadgeTone> = {
  open: "blue",
  running: "blue",
  in_review: "blue",
  pending: "blue",
  submitted: "blue",
  approved: "green",
  closed: "green",
  answered: "green",
  supported: "green",
  resolved: "green",
  ready: "green",
  operational: "green",
  overdue: "red",
  rejected: "red",
  breached: "red",
  contradicted: "red",
  failed: "red",
  critical: "red",
  draft: "gray",
  void: "gray",
  superseded: "gray",
  archived: "gray",
  at_risk: "amber",
  revise_and_resubmit: "amber",
  partially_supported: "amber",
  high: "amber",
};

/** Map a lifecycle status to a Badge tone. */
export function statusTone(status: string): string {
  const exact = LEGACY_STATUS_TONE[status];
  if (exact) return exact;
  return statusToLegacyTone(status);
}

/* ==========================================================================
   Avatar
   ========================================================================== */

export type AvatarSize = "2xs" | "xs" | "sm" | "md" | "lg" | "xl";

const AVATAR_SIZE: Record<AvatarSize, string> = {
  "2xs": "size-4 text-[0.5rem]",
  xs: "size-5 text-[0.5625rem]",
  sm: "size-6 text-2xs",
  md: "size-8 text-xs",
  lg: "size-10 text-sm",
  xl: "size-14 text-lg",
};

const AVATAR_STATUS: Record<string, string> = {
  online: "bg-success-solid",
  busy: "bg-danger-solid",
  away: "bg-warning-solid",
  offline: "bg-neutral-solid",
};

export interface AvatarProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  /** Drives the initials and the deterministic colour. */
  name?: string | null;
  /** Image URL. Falls back to initials when absent or broken. */
  src?: string | null;
  size?: AvatarSize;
  shape?: "circle" | "square";
  /** Presence dot. */
  status?: "online" | "offline" | "busy" | "away";
  /** Shown instead of initials when there is no name. */
  icon?: IconLike;
  /** Draw a ring in the surface colour (used by AvatarGroup). */
  ring?: boolean;
}

export function Avatar({
  name,
  src,
  size = "md",
  shape = "circle",
  status,
  icon,
  ring = false,
  className,
  title,
  ...rest
}: AvatarProps) {
  const [broken, setBroken] = useState(false);
  const seed = (name ?? "").trim();
  const initials = initialsFrom(seed);
  const showImage = Boolean(src) && !broken;
  const style = seed ? identityStyle(seed.toLowerCase()) : undefined;
  const dot = status ? AVATAR_STATUS[status] : undefined;

  return (
    <span
      className={cx(
        "relative inline-flex shrink-0 select-none items-center justify-center overflow-visible border font-semibold uppercase leading-none",
        shape === "circle" ? "rounded-full" : "rounded-md",
        AVATAR_SIZE[size],
        ring && "ring-2 ring-surface-raised",
        !seed && !showImage && "border-border bg-surface-sunken text-content-subtle",
        className,
      )}
      style={showImage ? undefined : style}
      title={title ?? (name ?? undefined)}
      {...rest}
    >
      {showImage ? (
        <img
          src={src ?? undefined}
          alt={name ?? ""}
          onError={() => setBroken(true)}
          className={cx(
            "size-full object-cover drag-none",
            shape === "circle" ? "rounded-full" : "rounded-md",
          )}
        />
      ) : seed ? (
        <span aria-hidden="true">{initials}</span>
      ) : (
        renderIcon(icon ?? IconUser, size === "xl" ? 24 : size === "lg" ? 18 : 14)
      )}
      {name && !showImage ? <VisuallyHidden>{name}</VisuallyHidden> : null}
      {dot ? (
        <span
          aria-hidden="true"
          className={cx(
            "absolute -bottom-px -right-px size-2 rounded-full ring-2 ring-surface-raised",
            dot,
          )}
        />
      ) : null}
    </span>
  );
}

export interface AvatarGroupProps extends HTMLAttributes<HTMLDivElement> {
  /** Declarative members. Ignored when `children` is provided. */
  people?: ReadonlyArray<{ name?: string | null; src?: string | null; title?: string }>;
  /** Show at most this many, then a "+N" chip. Default 4. */
  max?: number;
  size?: AvatarSize;
  shape?: "circle" | "square";
  /** Tooltip text for the overflow chip. */
  overflowTitle?: string;
}

export function AvatarGroup({
  people,
  max = 4,
  size = "sm",
  shape = "circle",
  overflowTitle,
  className,
  children,
  ...rest
}: AvatarGroupProps) {
  const list = people ?? [];
  const shown = list.slice(0, max);
  const overflow = list.length - shown.length;

  return (
    <div className={cx("flex items-center -space-x-1.5", className)} {...rest}>
      {children ??
        shown.map((person, index) => (
          <Avatar
            key={`${person.name ?? "avatar"}-${index}`}
            name={person.name}
            src={person.src}
            size={size}
            shape={shape}
            ring
            title={person.title}
          />
        ))}
      {overflow > 0 ? (
        <span
          title={overflowTitle ?? `${overflow} more`}
          className={cx(
            "relative inline-flex shrink-0 items-center justify-center border border-border bg-surface-sunken font-semibold leading-none text-content-muted ring-2 ring-surface-raised",
            shape === "circle" ? "rounded-full" : "rounded-md",
            AVATAR_SIZE[size],
          )}
        >
          +{overflow}
        </span>
      ) : null}
    </div>
  );
}

/* ==========================================================================
   Card
   ========================================================================== */

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** `raised` (default) sits on the page; `flat` and `sunken` recede. */
  variant?: "raised" | "flat" | "sunken" | "ghost";
  /** Add hover/press affordance and a pointer cursor. */
  interactive?: boolean;
  /** Lift the card with a shadow. */
  elevated?: boolean;
  /** Draw a tinted left rail — good for status-carrying cards. */
  accent?: Tone;
}

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { variant = "raised", interactive = false, elevated = false, accent, className, children, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cx(
        "relative rounded-lg border",
        variant === "raised" && "border-border bg-surface-raised",
        variant === "flat" && "border-border bg-transparent",
        variant === "sunken" && "border-border-subtle bg-surface-sunken",
        variant === "ghost" && "border-transparent bg-transparent",
        elevated ? "shadow-e2" : "shadow-e0",
        accent && cx("border-l-2", toneStyles[accent].border),
        interactive &&
          "cursor-pointer transition-[border-color,box-shadow,background-color] duration-fast ease-standard hover:border-border-strong hover:shadow-e2",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
});

export interface CardBodyProps extends HTMLAttributes<HTMLDivElement> {
  /** Remove the default padding. */
  flush?: boolean;
}

export const CardBody = forwardRef<HTMLDivElement, CardBodyProps>(function CardBody(
  { flush = false, className, children, ...rest },
  ref,
) {
  return (
    <div ref={ref} className={cx(flush ? "p-0" : "p-card", className)} {...rest}>
      {children}
    </div>
  );
});

export interface CardHeaderProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  title?: ReactNode;
  subtitle?: ReactNode;
  /** Right-aligned slot: buttons, menus, filters. */
  actions?: ReactNode;
  /** Leading glyph rendered in a tinted tile. */
  icon?: IconLike;
  /** Tone for the icon tile. */
  tone?: Tone;
  /** Draw the hairline under the header. Default `true`. */
  border?: boolean;
  /** Heading level for the title. Default 3. */
  level?: 2 | 3 | 4;
}

export function CardHeader({
  title,
  subtitle,
  actions,
  icon,
  tone: headerTone = "neutral",
  border = true,
  level = 3,
  className,
  children,
  ...rest
}: CardHeaderProps) {
  const Heading = (`h${level}` as unknown) as "h3";
  return (
    <div
      className={cx(
        "flex items-start justify-between gap-3 px-card py-3",
        border && "border-b border-border-subtle",
        className,
      )}
      {...rest}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        {icon ? (
          <span
            className={cx(
              "mt-px grid size-7 shrink-0 place-items-center rounded-md border",
              toneStyles[headerTone].subtle,
              toneStyles[headerTone].border,
            )}
          >
            {renderIcon(icon, 15)}
          </span>
        ) : null}
        <div className="min-w-0">
          {title !== undefined ? (
            <Heading className="truncate text-sm font-semibold text-content">{title}</Heading>
          ) : null}
          {subtitle !== undefined ? (
            <p className="mt-0.5 text-meta text-content-subtle">{subtitle}</p>
          ) : null}
          {children}
        </div>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
    </div>
  );
}

export interface CardFooterProps extends HTMLAttributes<HTMLDivElement> {
  align?: "start" | "between" | "end";
  /** Draw the hairline above the footer. Default `true`. */
  border?: boolean;
  /** Fill the footer with the sunken surface. */
  muted?: boolean;
}

export function CardFooter({
  align = "end",
  border = true,
  muted = false,
  className,
  children,
  ...rest
}: CardFooterProps) {
  return (
    <div
      className={cx(
        "flex items-center gap-2 rounded-b-lg px-card py-2.5",
        align === "start" && "justify-start",
        align === "between" && "justify-between",
        align === "end" && "justify-end",
        border && "border-t border-border-subtle",
        muted && "bg-surface-sunken",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

/* ==========================================================================
   PageHeader
   ========================================================================== */

export interface PageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Right-aligned action slot. */
  actions?: ReactNode;
  /** Slot above the title — usually `<Breadcrumbs />`. */
  breadcrumb?: ReactNode;
  /** Slot below the header — usually `<Tabs />`. */
  tabs?: ReactNode;
  /** Leading glyph in a tinted tile. */
  icon?: IconLike;
  /** Inline metadata row under the title (badges, ids, timestamps). */
  meta?: ReactNode;
  /** Stick to the top of the scroll container. */
  sticky?: boolean;
  /** Draw a hairline under the whole header. */
  border?: boolean;
  className?: string;
  children?: ReactNode;
}

export function PageHeader({
  title,
  subtitle,
  actions,
  breadcrumb,
  tabs,
  icon,
  meta,
  sticky = false,
  border = false,
  className,
  children,
}: PageHeaderProps) {
  return (
    <div
      className={cx(
        "mb-5",
        sticky && "sticky top-0 z-20 -mx-page-x bg-surface/85 px-page-x pt-page-y backdrop-blur",
        border && "border-b border-border pb-3",
        className,
      )}
    >
      {breadcrumb ? <div className="mb-2">{breadcrumb}</div> : null}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          {icon ? (
            <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-surface-raised text-content-muted shadow-e0">
              {renderIcon(icon, 18)}
            </span>
          ) : null}
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold tracking-[-0.012em] text-content">
              {title}
            </h1>
            {subtitle !== undefined ? (
              <p className="mt-0.5 text-body text-content-muted">{subtitle}</p>
            ) : null}
            {meta ? (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-meta text-content-subtle">
                {meta}
              </div>
            ) : null}
          </div>
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      {children}
      {tabs ? <div className="mt-3">{tabs}</div> : null}
    </div>
  );
}

/* ==========================================================================
   Table (legacy shape, new skin)
   ========================================================================== */

export interface TableProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  /** Tighten the cell padding. */
  dense?: boolean;
  /** Keep `<thead>` pinned while the container scrolls. */
  stickyHeader?: boolean;
  /** Drop the outer border/rounding — for tables already inside a Card. */
  flush?: boolean;
  /** Classes for the inner `<table>`. */
  tableClassName?: string;
}

export function Table({
  children,
  dense = false,
  stickyHeader = false,
  flush = false,
  className,
  tableClassName,
  ...rest
}: TableProps) {
  return (
    <div
      className={cx(
        "relative w-full overflow-x-auto",
        !flush && "rounded-lg border border-border bg-surface-raised shadow-e0",
        // These descendant rules deliberately out-specify any legacy
        // `bg-white` / `divide-ink-100` / `hover:bg-ink-50` still written on
        // <thead>/<tbody>/<tr> inside pages, so every existing table is
        // theme-correct without touching a single page.
        "[&_table]:w-full [&_table]:border-collapse",
        "[&_thead]:bg-surface-sunken [&_thead]:text-content-subtle",
        "[&_thead_tr]:border-0",
        "[&_thead_th]:border-b [&_thead_th]:border-border",
        stickyHeader && "[&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:z-10",
        "[&_tbody]:bg-transparent [&_tbody]:divide-y [&_tbody]:divide-border-subtle",
        "[&_tbody_tr]:transition-colors [&_tbody_tr:hover]:bg-surface-hover",
        "[&_tfoot]:bg-surface-sunken [&_tfoot_td]:border-t [&_tfoot_td]:border-border",
        dense && "[&_td]:py-1 [&_th]:py-1",
        className,
      )}
      {...rest}
    >
      <table className={cx("min-w-full text-body text-content", tableClassName)}>{children}</table>
    </div>
  );
}

export interface ThProps extends ThHTMLAttributes<HTMLTableCellElement> {
  children?: ReactNode;
  /** Right-align and switch on tabular figures. */
  numeric?: boolean;
  align?: "left" | "center" | "right";
  /** Render the sort affordance and make the header a button. */
  sortable?: boolean;
  /** Current sort direction for this column. */
  sortDirection?: "asc" | "desc" | null;
  onSort?: () => void;
}

export function Th({
  children,
  className,
  numeric = false,
  align,
  sortable = false,
  sortDirection = null,
  onSort,
  scope = "col",
  ...rest
}: ThProps) {
  const alignment = align ?? (numeric ? "right" : "left");
  const content = sortable ? (
    <button
      type="button"
      onClick={onSort}
      className={cx(
        "-mx-1 inline-flex max-w-full items-center gap-1 rounded px-1 py-0.5 transition-colors hover:text-content",
        alignment === "right" && "flex-row-reverse",
      )}
    >
      <span className="truncate">{children}</span>
      {sortDirection === "asc" ? (
        <IconChevronUp size={12} className="text-accent-text" />
      ) : sortDirection === "desc" ? (
        <IconChevronDown size={12} className="text-accent-text" />
      ) : (
        <IconChevronDown size={12} className="opacity-0 transition-opacity group-hover:opacity-40" />
      )}
    </button>
  ) : (
    children
  );

  return (
    <th
      scope={scope}
      aria-sort={
        sortable
          ? sortDirection === "asc"
            ? "ascending"
            : sortDirection === "desc"
              ? "descending"
              : "none"
          : undefined
      }
      className={cx(
        "group whitespace-nowrap px-cell-x py-2 text-label font-semibold uppercase text-content-subtle",
        alignment === "left" && "text-left",
        alignment === "center" && "text-center",
        alignment === "right" && "text-right",
        numeric && "tabular-nums",
        className,
      )}
      {...rest}
    >
      {content}
    </th>
  );
}

export interface TdProps extends TdHTMLAttributes<HTMLTableCellElement> {
  children?: ReactNode;
  title?: string;
  /** Right-align and switch on tabular figures. */
  numeric?: boolean;
  align?: "left" | "center" | "right";
  /** Clip overflowing content with an ellipsis. */
  truncate?: boolean;
  /** De-emphasise the cell. */
  muted?: boolean;
}

export function Td({
  children,
  className,
  title,
  numeric = false,
  align,
  truncate = false,
  muted = false,
  ...rest
}: TdProps) {
  const alignment = align ?? (numeric ? "right" : "left");
  return (
    <td
      className={cx(
        "px-cell-x py-cell-y align-middle text-content",
        alignment === "left" && "text-left",
        alignment === "center" && "text-center",
        alignment === "right" && "text-right",
        numeric && "tabular-nums",
        truncate && "max-w-0 truncate",
        muted && "text-content-muted",
        className,
      )}
      title={title}
      {...rest}
    >
      {children}
    </td>
  );
}

export interface TrProps extends HTMLAttributes<HTMLTableRowElement> {
  /** Paint the selected background. */
  selected?: boolean;
  /** Pointer cursor + keyboard activation. */
  interactive?: boolean;
}

export const Tr = forwardRef<HTMLTableRowElement, TrProps>(function Tr(
  { selected = false, interactive = false, className, onClick, children, ...rest },
  ref,
) {
  return (
    <tr
      ref={ref}
      data-selected={selected ? "" : undefined}
      aria-selected={selected || undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={onClick}
      onKeyDown={
        interactive
          ? (event) => {
              if (event.key === "Enter" && event.currentTarget === event.target) {
                event.currentTarget.click();
              }
            }
          : undefined
      }
      className={cx(
        selected && "bg-surface-selected",
        interactive &&
          "cursor-pointer focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
        className,
      )}
      {...rest}
    >
      {children}
    </tr>
  );
});

export function THead({ className, children, ...rest }: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead className={cx(className)} {...rest}>
      {children}
    </thead>
  );
}

export function TBody({ className, children, ...rest }: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <tbody className={cx(className)} {...rest}>
      {children}
    </tbody>
  );
}

/* ==========================================================================
   Spinner / Skeleton / Progress
   ========================================================================== */

export interface SpinnerProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  /** Visible caption. Default "Loading…". */
  label?: string;
  /** Suppress the caption entirely (still announced to screen readers). */
  hideLabel?: boolean;
  size?: "sm" | "md" | "lg";
  /** Render inline instead of a centred block with vertical padding. */
  inline?: boolean;
}

export function Spinner({
  label,
  hideLabel = false,
  size = "md",
  inline = false,
  className,
  ...rest
}: SpinnerProps) {
  const px = size === "sm" ? 14 : size === "lg" ? 24 : 18;
  const text = label ?? "Loading…";
  return (
    <div
      role="status"
      aria-live="polite"
      className={cx(
        "flex items-center gap-2 text-body text-content-subtle",
        inline ? "inline-flex" : "justify-center py-10",
        className,
      )}
      {...rest}
    >
      <IconSpinner size={px} className="text-accent" />
      {hideLabel ? <VisuallyHidden>{text}</VisuallyHidden> : text}
    </div>
  );
}

const SKELETON_RADIUS: Record<"xs" | "sm" | "md" | "lg" | "full", string> = {
  xs: "rounded-xs",
  sm: "rounded-sm",
  md: "rounded-md",
  lg: "rounded-lg",
  full: "rounded-full",
};

export interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  variant?: "text" | "rect" | "circle";
  width?: number | string;
  height?: number | string;
  /** For `variant="text"`: how many lines to draw. Default 1. */
  lines?: number;
  radius?: "xs" | "sm" | "md" | "lg" | "full";
}

export function Skeleton({
  variant = "rect",
  width,
  height,
  lines = 1,
  radius,
  className,
  style,
  ...rest
}: SkeletonProps) {
  const shape =
    variant === "circle"
      ? "rounded-full"
      : radius
        ? SKELETON_RADIUS[radius]
        : variant === "text"
          ? "rounded-xs"
          : "rounded-md";

  if (variant === "text" && lines > 1) {
    return (
      <div className={cx("flex w-full flex-col gap-1.5", className)} style={style} {...rest}>
        {Array.from({ length: lines }).map((_, index) => (
          <div
            key={index}
            aria-hidden="true"
            className={cx("skeleton h-3", shape)}
            style={{ width: index === lines - 1 ? "62%" : "100%" }}
          />
        ))}
      </div>
    );
  }

  return (
    <div
      aria-hidden="true"
      className={cx(
        "skeleton",
        shape,
        variant === "text" && "h-3 w-full",
        variant === "circle" && !width && "size-8",
        className,
      )}
      style={{ width, height, ...style }}
      {...rest}
    />
  );
}

export function SkeletonText({
  lines = 3,
  className,
  ...rest
}: Omit<SkeletonProps, "variant"> & { lines?: number }) {
  return <Skeleton variant="text" lines={lines} className={className} {...rest} />;
}

export interface SkeletonTableProps extends HTMLAttributes<HTMLDivElement> {
  rows?: number;
  columns?: number;
  /** Draw the header strip. Default `true`. */
  header?: boolean;
}

export function SkeletonTable({
  rows = 6,
  columns = 5,
  header = true,
  className,
  ...rest
}: SkeletonTableProps) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading table"
      className={cx(
        "w-full overflow-hidden rounded-lg border border-border bg-surface-raised shadow-e0",
        className,
      )}
      {...rest}
    >
      {header ? (
        <div
          className="grid gap-cell-x border-b border-border bg-surface-sunken px-cell-x py-2.5"
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
        >
          {Array.from({ length: columns }).map((_, index) => (
            <div key={index} className="skeleton h-2.5 rounded-xs" style={{ width: "58%" }} />
          ))}
        </div>
      ) : null}
      <div className="divide-y divide-border-subtle">
        {Array.from({ length: rows }).map((_, rowIndex) => (
          <div
            key={rowIndex}
            className="grid items-center gap-cell-x px-cell-x py-cell-y"
            style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
          >
            {Array.from({ length: columns }).map((_, colIndex) => (
              <div
                key={colIndex}
                className="skeleton h-3 rounded-xs"
                style={{ width: colIndex === 0 ? "82%" : `${45 + ((rowIndex * 7 + colIndex * 13) % 40)}%` }}
              />
            ))}
          </div>
        ))}
      </div>
      <VisuallyHidden>Loading</VisuallyHidden>
    </div>
  );
}

export interface ProgressProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  /** 0…`max`. Pass `null`/omit with `indeterminate` for unknown progress. */
  value?: number | null;
  max?: number;
  tone?: Tone;
  size?: "xs" | "sm" | "md";
  /** Caption above the bar. */
  label?: ReactNode;
  /** Render the percentage on the right of the caption row. */
  showValue?: boolean;
  /** Animate a travelling sliver instead of a fill. */
  indeterminate?: boolean;
  /** Custom formatter for `showValue`. */
  formatValue?: (value: number, max: number) => string;
}

export function Progress({
  value = 0,
  max = 100,
  tone: progressTone = "accent",
  size = "sm",
  label,
  showValue = false,
  indeterminate = false,
  formatValue,
  className,
  ...rest
}: ProgressProps) {
  const safeMax = max || 100;
  const raw = value ?? 0;
  const pct = Math.min(100, Math.max(0, (raw / safeMax) * 100));
  const height = size === "xs" ? "h-1" : size === "sm" ? "h-1.5" : "h-2.5";
  const fill = toneStyles[progressTone].dot;
  const display = formatValue ? formatValue(raw, safeMax) : `${Math.round(pct)}%`;

  return (
    <div className={cx("w-full", className)} {...rest}>
      {label !== undefined || showValue ? (
        <div className="mb-1.5 flex items-baseline justify-between gap-2">
          {label !== undefined ? (
            <span className="text-meta font-medium text-content-muted">{label}</span>
          ) : (
            <span />
          )}
          {showValue && !indeterminate ? (
            <span className="text-meta tabular-nums text-content">{display}</span>
          ) : null}
        </div>
      ) : null}
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={safeMax}
        aria-valuenow={indeterminate ? undefined : raw}
        aria-valuetext={indeterminate ? undefined : display}
        className={cx("w-full overflow-hidden rounded-full bg-neutral-subtle", height)}
      >
        {indeterminate ? (
          <div className={cx("h-full w-full origin-left rounded-full animate-indeterminate", fill)} />
        ) : (
          <div
            className={cx("h-full rounded-full transition-[width] duration-slow ease-emphasized", fill)}
            style={{ width: `${pct}%` }}
          />
        )}
      </div>
    </div>
  );
}

export interface ProgressRingProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  value?: number;
  max?: number;
  /** Outer diameter in px. Default 40. */
  size?: number;
  /** Stroke width in px. Default 4. */
  thickness?: number;
  tone?: Tone;
  /** Print the percentage in the middle. */
  showValue?: boolean;
  /** Content for the middle (overrides `showValue`). */
  label?: ReactNode;
}

export function ProgressRing({
  value = 0,
  max = 100,
  size = 40,
  thickness = 4,
  tone: ringTone = "accent",
  showValue = false,
  label,
  className,
  ...rest
}: ProgressRingProps) {
  const safeMax = max || 100;
  const pct = Math.min(100, Math.max(0, (value / safeMax) * 100));
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const stroke = ringTone === "accent" ? "var(--ds-accent)" : `var(--ds-${ringTone}-solid)`;

  return (
    <div
      className={cx("relative inline-grid shrink-0 place-items-center", className)}
      style={{ width: size, height: size }}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={safeMax}
      aria-valuenow={value}
      {...rest}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={thickness}
          stroke="var(--ds-neutral-subtle)"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={thickness}
          stroke={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - pct / 100)}
          className="transition-[stroke-dashoffset] duration-slow ease-emphasized"
        />
      </svg>
      {label !== undefined ? (
        <span className="absolute inset-0 grid place-items-center">{label}</span>
      ) : showValue ? (
        <span className="absolute inset-0 grid place-items-center text-2xs font-semibold tabular-nums text-content">
          {Math.round(pct)}%
        </span>
      ) : null}
    </div>
  );
}

/* ==========================================================================
   Divider / Kbd
   ========================================================================== */

export interface DividerProps extends HTMLAttributes<HTMLDivElement> {
  orientation?: "horizontal" | "vertical";
  /** Text or node centred on the rule. */
  label?: ReactNode;
  /** Vertical rhythm around a horizontal rule. */
  spacing?: "none" | "sm" | "md" | "lg";
  /** Use the faintest border token. */
  subtle?: boolean;
}

export function Divider({
  orientation = "horizontal",
  label,
  spacing = "md",
  subtle = false,
  className,
  ...rest
}: DividerProps) {
  const line = subtle ? "border-border-subtle" : "border-border";

  if (orientation === "vertical") {
    return (
      <div
        role="separator"
        aria-orientation="vertical"
        className={cx("h-full w-px shrink-0 self-stretch border-l", line, className)}
        {...rest}
      />
    );
  }

  const gap =
    spacing === "none" ? "" : spacing === "sm" ? "my-2" : spacing === "lg" ? "my-6" : "my-4";

  if (label !== undefined) {
    return (
      <div className={cx("flex w-full items-center gap-3", gap, className)} {...rest}>
        <span className={cx("h-px flex-1 border-t", line)} />
        <span className="shrink-0 text-label uppercase text-content-subtle">{label}</span>
        <span className={cx("h-px flex-1 border-t", line)} />
      </div>
    );
  }

  return (
    <div
      role="separator"
      className={cx("h-px w-full border-t", line, gap, className)}
      {...rest}
    />
  );
}

export interface KbdProps extends HTMLAttributes<HTMLElement> {
  /** Render a sequence of keys, e.g. `["⌘", "K"]`. */
  keys?: ReadonlyArray<string>;
  size?: "xs" | "sm";
}

export function Kbd({ keys, size = "sm", className, children, ...rest }: KbdProps) {
  const chip = cx(
    "inline-flex shrink-0 items-center justify-center rounded-xs border border-border bg-surface-sunken font-mono font-medium text-content-muted shadow-e0",
    size === "xs" ? "h-4 min-w-4 px-1 text-[0.625rem]" : "h-5 min-w-5 px-1.5 text-2xs",
  );

  if (keys && keys.length > 0) {
    return (
      <span className={cx("inline-flex items-center gap-1", className)} {...rest}>
        {keys.map((key, index) => (
          <kbd key={`${key}-${index}`} className={chip}>
            {key}
          </kbd>
        ))}
      </span>
    );
  }

  return (
    <kbd className={cx(chip, className)} {...rest}>
      {children}
    </kbd>
  );
}

/* ==========================================================================
   Stat
   ========================================================================== */

export interface StatProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  label: ReactNode;
  value: ReactNode;
  /** Signed change. Drives the arrow and the good/bad colour. */
  delta?: number | null;
  /** Overrides the rendered delta text. */
  deltaLabel?: ReactNode;
  /** Appended to a numeric delta. Default "%". */
  deltaSuffix?: string;
  /** Is "up" the good direction? Default `true`. Set false for cost overrun. */
  higherIsBetter?: boolean;
  /** Force the arrow direction, ignoring `delta`. */
  trend?: Direction;
  /** Slot for a sparkline / mini chart, rendered under the value. */
  sparkline?: ReactNode;
  /** Leading glyph in a tinted tile. */
  icon?: IconLike;
  tone?: Tone;
  /** Small caption under the delta row. */
  hint?: ReactNode;
  /** Footer slot, separated by a hairline. */
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
  loading?: boolean;
}

export function Stat({
  label,
  value,
  delta,
  deltaLabel,
  deltaSuffix = "%",
  higherIsBetter = true,
  trend,
  sparkline,
  icon,
  tone: statTone = "neutral",
  hint,
  footer,
  size = "md",
  loading = false,
  className,
  ...rest
}: StatProps) {
  const hasDelta = delta !== undefined && delta !== null;
  const direction: Direction | undefined = trend ?? (hasDelta ? directionOf(delta) : undefined);
  const deltaTone: Tone = hasDelta ? deltaToTone(delta, { higherIsBetter }) : "neutral";
  const valueSize =
    size === "sm" ? "text-lg" : size === "lg" ? "text-display-sm" : "text-display-xs";

  return (
    <div className={cx("flex flex-col gap-1", className)} {...rest}>
      <div className="flex items-start justify-between gap-2">
        <span className="text-label uppercase text-content-subtle">{label}</span>
        {icon ? (
          <span
            className={cx(
              "grid size-6 shrink-0 place-items-center rounded-md border",
              toneStyles[statTone].subtle,
              toneStyles[statTone].border,
            )}
          >
            {renderIcon(icon, 13)}
          </span>
        ) : null}
      </div>

      {loading ? (
        <div className="skeleton h-7 w-24 rounded-md" aria-hidden="true" />
      ) : (
        <div
          className={cx(
            "font-semibold tabular-nums leading-tight tracking-[-0.02em] text-content",
            valueSize,
          )}
        >
          {value}
        </div>
      )}

      {sparkline ? <div className="mt-1 h-8 w-full">{sparkline}</div> : null}

      {hasDelta || deltaLabel !== undefined ? (
        <div className="mt-0.5 flex items-center gap-1.5">
          <span
            className={cx(
              "inline-flex items-center gap-0.5 text-meta font-medium tabular-nums",
              toneStyles[deltaTone].text,
            )}
          >
            {direction === "up" ? (
              <IconArrowUp size={12} strokeWidth={2.25} />
            ) : direction === "down" ? (
              <IconArrowDown size={12} strokeWidth={2.25} />
            ) : (
              <IconMinus size={12} strokeWidth={2.25} />
            )}
            {deltaLabel ??
              (hasDelta
                ? `${delta > 0 ? "+" : ""}${Math.abs(delta) < 100 ? Number(delta.toFixed(1)) : Math.round(delta)}${deltaSuffix}`
                : null)}
          </span>
          {hint !== undefined ? (
            <span className="truncate text-meta text-content-subtle">{hint}</span>
          ) : null}
        </div>
      ) : hint !== undefined ? (
        <span className="text-meta text-content-subtle">{hint}</span>
      ) : null}

      {footer ? (
        <div className="mt-2 border-t border-border-subtle pt-2 text-meta text-content-subtle">
          {footer}
        </div>
      ) : null}
    </div>
  );
}

/* ==========================================================================
   Alert / Callout / ErrorAlert
   ========================================================================== */

export interface AlertProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  tone?: Tone;
  variant?: "subtle" | "outline" | "solid" | "bare";
  title?: ReactNode;
  /** Override the tone's default glyph. Pass `false` to hide it. */
  icon?: IconLike | false;
  /** Renders a dismiss button. */
  onDismiss?: () => void;
  dismissLabel?: string;
  /** Right/bottom action slot (buttons, links). */
  actions?: ReactNode;
  size?: "sm" | "md";
}

export function Alert({
  tone: alertTone = "info",
  variant = "subtle",
  title,
  icon,
  onDismiss,
  dismissLabel = "Dismiss",
  actions,
  size = "md",
  className,
  children,
  role,
  ...rest
}: AlertProps) {
  const styles = toneStyles[alertTone];
  const Glyph = toneIcon(alertTone);
  const showIcon = icon !== false;

  return (
    <div
      role={role ?? (alertTone === "danger" ? "alert" : "status")}
      className={cx(
        "flex w-full items-start gap-2.5 rounded-lg border",
        size === "sm" ? "px-2.5 py-2 text-meta" : "px-3 py-2.5 text-body",
        variant === "solid"
          ? cx(styles.solid, "border-transparent")
          : variant === "outline"
            ? cx("bg-surface-raised", styles.border, styles.text)
            : variant === "bare"
              ? cx("border-transparent bg-transparent", styles.text)
              : cx(styles.subtle, styles.border),
        className,
      )}
      {...rest}
    >
      {showIcon ? (
        <span className="mt-px shrink-0">
          {icon ? renderIcon(icon, size === "sm" ? 14 : 16) : <Glyph size={size === "sm" ? 14 : 16} />}
        </span>
      ) : null}
      <div className="min-w-0 flex-1">
        {title !== undefined ? (
          <div className={cx("font-semibold", size === "sm" ? "text-meta" : "text-body")}>
            {title}
          </div>
        ) : null}
        {children !== undefined && children !== null ? (
          <div className={cx(title !== undefined && "mt-0.5", "[&_a]:underline [&_a]:underline-offset-2")}>
            {children}
          </div>
        ) : null}
        {actions ? <div className="mt-2 flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={dismissLabel}
          className="-mr-1 -mt-0.5 grid size-6 shrink-0 place-items-center rounded-md opacity-60 transition-opacity hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10"
        >
          <IconClose size={14} />
        </button>
      ) : null}
    </div>
  );
}

/** Alias of `Alert` — same component, the name that reads better in docs. */
export const Callout = Alert;
export type CalloutProps = AlertProps;

export interface ErrorAlertProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  /** Renders nothing when null/undefined/empty. */
  message?: ReactNode | null;
  title?: ReactNode;
  /** Adds a "Retry" button. */
  onRetry?: () => void;
  retryLabel?: string;
  onDismiss?: () => void;
}

export function ErrorAlert({
  message,
  title,
  onRetry,
  retryLabel = "Retry",
  onDismiss,
  className,
  ...rest
}: ErrorAlertProps) {
  if (message === null || message === undefined || message === "") return null;
  return (
    <Alert
      tone="danger"
      title={title}
      onDismiss={onDismiss}
      className={cx("mb-3", className)}
      actions={
        onRetry ? (
          <Button size="xs" variant="secondary" leadingIcon={IconRefresh} onClick={onRetry}>
            {retryLabel}
          </Button>
        ) : undefined
      }
      {...rest}
    >
      {message}
    </Alert>
  );
}

/* ==========================================================================
   EmptyState
   ========================================================================== */

export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  title: ReactNode;
  /** Supporting copy. */
  hint?: ReactNode;
  /** Alias of `hint`. */
  description?: ReactNode;
  /** Primary action slot. */
  action?: ReactNode;
  /** Secondary action slot, rendered beside `action`. */
  secondaryAction?: ReactNode;
  /** Illustration glyph, rendered in a tinted tile. */
  icon?: IconLike;
  tone?: Tone;
  size?: "sm" | "md" | "lg";
  /** Draw the dashed container. Default `true`. */
  bordered?: boolean;
}

export function EmptyState({
  title,
  hint,
  description,
  action,
  secondaryAction,
  icon,
  tone: emptyTone = "neutral",
  size = "md",
  bordered = true,
  className,
  children,
  ...rest
}: EmptyStateProps) {
  const copy = hint ?? description;
  const styles = toneStyles[emptyTone];
  const pad = size === "sm" ? "px-4 py-8" : size === "lg" ? "px-8 py-20" : "px-6 py-14";
  const tile = size === "sm" ? "size-9" : size === "lg" ? "size-14" : "size-11";
  const glyph = size === "sm" ? 18 : size === "lg" ? 26 : 21;

  return (
    <div
      className={cx(
        "relative flex flex-col items-center justify-center overflow-hidden rounded-lg text-center",
        bordered && "border border-dashed border-border bg-surface-raised/60",
        pad,
        className,
      )}
      {...rest}
    >
      <div className="pointer-events-none absolute inset-0 grid-bg opacity-50 mask-fade-y" aria-hidden="true" />
      <div className="relative flex flex-col items-center">
        <div
          className={cx(
            "grid shrink-0 place-items-center rounded-xl border shadow-e0",
            tile,
            styles.subtle,
            styles.border,
          )}
          aria-hidden="true"
        >
          {icon ? renderIcon(icon, glyph) : <IconEmpty size={glyph} />}
        </div>
        <p
          className={cx(
            "mt-3 font-semibold text-content",
            size === "lg" ? "text-base" : "text-sm",
          )}
        >
          {title}
        </p>
        {copy !== undefined && copy !== null ? (
          <p className="mt-1 max-w-prose text-balance text-meta text-content-subtle">{copy}</p>
        ) : null}
        {children}
        {action || secondaryAction ? (
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            {action}
            {secondaryAction}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ==========================================================================
   Tabs
   ========================================================================== */

export interface TabItem<T extends string = string> {
  value: T;
  label: ReactNode;
  icon?: IconLike;
  /** Trailing count chip. */
  count?: number;
  disabled?: boolean;
  /** Tone for the count chip. */
  tone?: Tone;
}

export interface TabsProps<T extends string = string> {
  items: ReadonlyArray<TabItem<T>>;
  value: T;
  onChange: (value: T) => void;
  variant?: "underline" | "pill" | "enclosed";
  size?: "sm" | "md";
  /** Distribute the tabs across the full width. */
  fullWidth?: boolean;
  /** Accessible name for the tablist. */
  "aria-label"?: string;
  /** `automatic` selects on arrow-key focus (default); `manual` waits for Enter. */
  activationMode?: "automatic" | "manual";
  /**
   * Set when the tabs drive sibling `<TabPanel>`s. Only then is `aria-controls`
   * emitted — pointing it at an element that does not exist is an ARIA error,
   * and most call sites swap content without rendering a panel.
   */
  linkPanels?: boolean;
  className?: string;
}

export function Tabs<T extends string = string>({
  items,
  value,
  onChange,
  variant = "underline",
  size = "md",
  fullWidth = false,
  activationMode = "automatic",
  linkPanels = false,
  className,
  ...aria
}: TabsProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const height = size === "sm" ? "h-8" : "h-9";
  const text = size === "sm" ? "text-xs" : "text-body";
  const iconPx = size === "sm" ? 13 : 15;

  const focusTab = useCallback(
    (from: number, delta: number) => {
      const total = items.length;
      if (total === 0) return;
      let next = from;
      for (let step = 0; step < total; step += 1) {
        next = (next + delta + total) % total;
        const candidate = items[next];
        if (candidate && !candidate.disabled) {
          refs.current[next]?.focus();
          if (activationMode === "automatic") onChange(candidate.value);
          return;
        }
      }
    },
    [activationMode, items, onChange],
  );

  return (
    <div
      role="tablist"
      aria-label={aria["aria-label"]}
      aria-orientation="horizontal"
      className={cx(
        "flex items-center overflow-x-auto no-scrollbar",
        variant === "underline" && "gap-1 border-b border-border",
        variant === "pill" && "gap-1",
        variant === "enclosed" &&
          "gap-0.5 rounded-lg border border-border bg-surface-sunken p-0.5",
        fullWidth && "w-full",
        className,
      )}
    >
      {items.map((item, index) => {
        const selected = item.value === value;
        return (
          <button
            key={item.value}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            role="tab"
            id={`tab-${item.value}`}
            aria-selected={selected}
            aria-controls={linkPanels ? `tabpanel-${item.value}` : undefined}
            aria-disabled={item.disabled || undefined}
            disabled={item.disabled}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(item.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight") {
                event.preventDefault();
                focusTab(index, 1);
              } else if (event.key === "ArrowLeft") {
                event.preventDefault();
                focusTab(index, -1);
              } else if (event.key === "Home") {
                event.preventDefault();
                focusTab(-1, 1);
              } else if (event.key === "End") {
                event.preventDefault();
                focusTab(0, -1);
              } else if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onChange(item.value);
              }
            }}
            className={cx(
              "relative inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap font-medium",
              "transition-[color,background-color,box-shadow] duration-fast ease-standard",
              "disabled:cursor-not-allowed disabled:opacity-45",
              height,
              text,
              fullWidth && "flex-1",
              variant === "underline" &&
                cx(
                  "-mb-px rounded-t-md border-b-2 px-3",
                  selected
                    ? "border-accent text-content"
                    : "border-transparent text-content-muted hover:border-border-strong hover:text-content",
                ),
              variant === "pill" &&
                cx(
                  "rounded-full px-3",
                  selected
                    ? "bg-accent-subtle text-accent-subtle-fg"
                    : "text-content-muted hover:bg-surface-hover hover:text-content",
                ),
              variant === "enclosed" &&
                cx(
                  "rounded-md px-3",
                  selected
                    ? "bg-surface-raised text-content shadow-e1"
                    : "text-content-muted hover:text-content",
                ),
            )}
          >
            {renderIcon(item.icon, iconPx)}
            <span className="truncate">{item.label}</span>
            {item.count !== undefined ? (
              <span
                className={cx(
                  "ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-2xs font-semibold tabular-nums",
                  item.tone
                    ? toneStyles[item.tone].subtle
                    : selected
                      ? "bg-accent-subtle text-accent-subtle-fg"
                      : "bg-neutral-subtle text-content-subtle",
                )}
              >
                {item.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export interface TabPanelProps extends HTMLAttributes<HTMLDivElement> {
  /** Must match the `TabItem.value` this panel belongs to. */
  value: string;
  /** Render only when active. Default `true`. */
  active: boolean;
  /** Keep the panel mounted while inactive (preserves scroll/state). */
  keepMounted?: boolean;
}

export function TabPanel({
  value,
  active,
  keepMounted = false,
  className,
  children,
  ...rest
}: TabPanelProps) {
  if (!active && !keepMounted) return null;
  return (
    <div
      role="tabpanel"
      id={`tabpanel-${value}`}
      aria-labelledby={`tab-${value}`}
      hidden={!active}
      tabIndex={0}
      className={cx("outline-none", className)}
      {...rest}
    >
      {children}
    </div>
  );
}

/* ==========================================================================
   Breadcrumbs
   ========================================================================== */

export interface BreadcrumbItem {
  label: ReactNode;
  href?: string;
  onClick?: () => void;
  icon?: IconLike;
}

export interface BreadcrumbsProps extends Omit<HTMLAttributes<HTMLElement>, "onClick"> {
  items: ReadonlyArray<BreadcrumbItem>;
  /** Collapse the middle when there are more than this many. Default 4. */
  maxItems?: number;
  /** Separator node. Default a thin slash. */
  separator?: ReactNode;
  size?: "sm" | "md";
}

export function Breadcrumbs({
  items,
  maxItems = 4,
  separator,
  size = "sm",
  className,
  ...rest
}: BreadcrumbsProps) {
  const [expanded, setExpanded] = useState(false);
  const collapse = !expanded && items.length > maxItems && maxItems >= 2;
  const visible: Array<BreadcrumbItem | "ellipsis"> = collapse
    ? [items[0] as BreadcrumbItem, "ellipsis", ...items.slice(items.length - (maxItems - 2))]
    : [...items];

  const sep = separator ?? <IconSlash size={12} className="text-content-disabled" />;
  const text = size === "sm" ? "text-meta" : "text-body";

  return (
    <nav aria-label="Breadcrumb" className={cx("min-w-0", className)} {...rest}>
      <ol className={cx("flex flex-wrap items-center gap-1", text)}>
        {visible.map((entry, index) => {
          const isLast = index === visible.length - 1;
          if (entry === "ellipsis") {
            return (
              <li key="ellipsis" className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setExpanded(true)}
                  aria-label="Show all breadcrumbs"
                  className="rounded px-1 text-content-subtle transition-colors hover:bg-surface-hover hover:text-content"
                >
                  …
                </button>
                <span aria-hidden="true">{sep}</span>
              </li>
            );
          }

          const content = (
            <>
              {renderIcon(entry.icon, 13)}
              <span className="truncate">{entry.label}</span>
            </>
          );

          return (
            <li key={index} className="flex min-w-0 items-center gap-1">
              {isLast ? (
                <span
                  aria-current="page"
                  className="inline-flex min-w-0 items-center gap-1 font-medium text-content"
                >
                  {content}
                </span>
              ) : entry.href || entry.onClick ? (
                <a
                  href={entry.href ?? "#"}
                  onClick={
                    entry.onClick
                      ? (event) => {
                          if (!entry.href) event.preventDefault();
                          entry.onClick?.();
                        }
                      : undefined
                  }
                  className="inline-flex min-w-0 items-center gap-1 rounded px-0.5 text-content-muted transition-colors hover:text-content hover:underline underline-offset-2"
                >
                  {content}
                </a>
              ) : (
                <span className="inline-flex min-w-0 items-center gap-1 text-content-muted">
                  {content}
                </span>
              )}
              {isLast ? null : <span aria-hidden="true">{sep}</span>}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/* ==========================================================================
   Stepper
   ========================================================================== */

export type StepStatus = "complete" | "current" | "upcoming" | "error";

export interface StepItem {
  id?: string;
  label: ReactNode;
  description?: ReactNode;
  status?: StepStatus;
  icon?: IconLike;
  disabled?: boolean;
}

export interface StepperProps extends HTMLAttributes<HTMLElement> {
  steps: ReadonlyArray<StepItem>;
  /** Index of the current step. Used when a step has no explicit `status`. */
  current?: number;
  orientation?: "horizontal" | "vertical";
  size?: "sm" | "md";
  /** Make the steps clickable. */
  onStepClick?: (index: number, step: StepItem) => void;
}

export function Stepper({
  steps,
  current = 0,
  orientation = "horizontal",
  size = "md",
  onStepClick,
  className,
  ...rest
}: StepperProps) {
  const dot = size === "sm" ? "size-5 text-[0.625rem]" : "size-6 text-2xs";
  const vertical = orientation === "vertical";

  const statusOf = (step: StepItem, index: number): StepStatus =>
    step.status ?? (index < current ? "complete" : index === current ? "current" : "upcoming");

  return (
    <nav
      aria-label="Progress"
      className={cx(vertical ? "flex flex-col" : "flex items-start", className)}
      {...rest}
    >
      <ol className={cx(vertical ? "flex flex-col gap-0" : "flex w-full items-start")}>
        {steps.map((step, index) => {
          const status = statusOf(step, index);
          const isLast = index === steps.length - 1;
          const clickable = Boolean(onStepClick) && !step.disabled;

          const marker = (
            <span
              className={cx(
                "grid shrink-0 place-items-center rounded-full border font-semibold transition-colors",
                dot,
                status === "complete" && "border-transparent bg-accent text-accent-fg",
                status === "current" && "border-accent bg-accent-subtle text-accent-subtle-fg ring-4 ring-accent/15",
                status === "upcoming" && "border-border bg-surface-raised text-content-subtle",
                status === "error" && "border-transparent bg-danger-solid text-danger-on-solid",
              )}
            >
              {status === "complete" ? (
                <IconCheck size={size === "sm" ? 11 : 13} strokeWidth={3} />
              ) : status === "error" ? (
                <IconClose size={size === "sm" ? 11 : 13} strokeWidth={3} />
              ) : step.icon ? (
                renderIcon(step.icon, size === "sm" ? 11 : 13)
              ) : (
                index + 1
              )}
            </span>
          );

          const body = (
            <span className={cx("min-w-0", vertical ? "pb-5" : "")}>
              <span
                className={cx(
                  "block truncate font-medium",
                  size === "sm" ? "text-meta" : "text-body",
                  status === "upcoming" ? "text-content-subtle" : "text-content",
                )}
              >
                {step.label}
              </span>
              {step.description !== undefined ? (
                <span className="mt-0.5 block text-meta text-content-subtle">
                  {step.description}
                </span>
              ) : null}
            </span>
          );

          return (
            <li
              key={step.id ?? index}
              aria-current={status === "current" ? "step" : undefined}
              className={cx(
                vertical ? "relative flex gap-3" : "flex min-w-0 flex-1 items-start gap-2.5",
                !vertical && !isLast && "pr-3",
              )}
            >
              {vertical ? (
                <span className="relative flex flex-col items-center">
                  {marker}
                  {isLast ? null : (
                    <span
                      aria-hidden="true"
                      className={cx(
                        "mt-1 w-px flex-1 self-center",
                        status === "complete" ? "bg-accent/50" : "bg-border",
                      )}
                    />
                  )}
                </span>
              ) : (
                marker
              )}

              {clickable ? (
                <button
                  type="button"
                  onClick={() => onStepClick?.(index, step)}
                  className="min-w-0 rounded text-left"
                >
                  {body}
                </button>
              ) : (
                body
              )}

              {!vertical && !isLast ? (
                <span
                  aria-hidden="true"
                  className={cx(
                    "mt-3 h-px min-w-4 flex-1",
                    status === "complete" ? "bg-accent/50" : "bg-border",
                  )}
                />
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/* ==========================================================================
   Accordion
   ========================================================================== */

export interface AccordionItemData {
  id: string;
  title: ReactNode;
  content: ReactNode;
  /** Leading glyph. */
  icon?: IconLike;
  /** Right-aligned slot on the trigger row (badges, counts). */
  meta?: ReactNode;
  disabled?: boolean;
}

export interface AccordionProps extends Omit<HTMLAttributes<HTMLDivElement>, "onChange"> {
  items: ReadonlyArray<AccordionItemData>;
  /** `single` closes the others; `multiple` allows many open. Default `single`. */
  type?: "single" | "multiple";
  /** Controlled open ids. */
  value?: ReadonlyArray<string>;
  defaultValue?: ReadonlyArray<string>;
  onValueChange?: (value: string[]) => void;
  variant?: "bordered" | "separated" | "ghost";
  size?: "sm" | "md";
}

export function Accordion({
  items,
  type = "single",
  value,
  defaultValue,
  onValueChange,
  variant = "bordered",
  size = "md",
  className,
  ...rest
}: AccordionProps) {
  const [open, setOpen] = useControllableState<ReadonlyArray<string>>(
    value,
    defaultValue ?? [],
    onValueChange as ((next: ReadonlyArray<string>) => void) | undefined,
  );

  const toggle = useCallback(
    (id: string) => {
      const isOpen = open.includes(id);
      if (type === "single") {
        setOpen(isOpen ? [] : [id]);
      } else {
        setOpen(isOpen ? open.filter((entry) => entry !== id) : [...open, id]);
      }
    },
    [open, setOpen, type],
  );

  return (
    <div
      className={cx(
        variant === "bordered" &&
          "divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface-raised",
        variant === "separated" && "flex flex-col gap-2",
        className,
      )}
      {...rest}
    >
      {items.map((item) => {
        const isOpen = open.includes(item.id);
        return (
          <div
            key={item.id}
            className={cx(
              variant === "separated" && "overflow-hidden rounded-lg border border-border bg-surface-raised",
              variant === "ghost" && "border-b border-border-subtle last:border-b-0",
            )}
          >
            <h3>
              <button
                type="button"
                aria-expanded={isOpen}
                aria-controls={`acc-panel-${item.id}`}
                id={`acc-trigger-${item.id}`}
                disabled={item.disabled}
                onClick={() => toggle(item.id)}
                className={cx(
                  "flex w-full items-center gap-2.5 text-left font-medium transition-colors",
                  size === "sm" ? "px-3 py-2 text-meta" : "px-3.5 py-2.5 text-body",
                  "text-content hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50",
                )}
              >
                <IconChevronRight
                  size={14}
                  className={cx(
                    "shrink-0 text-content-subtle transition-transform duration-fast ease-standard",
                    isOpen && "rotate-90",
                  )}
                />
                {renderIcon(item.icon, 15, "text-content-muted")}
                <span className="min-w-0 flex-1 truncate">{item.title}</span>
                {item.meta ? <span className="shrink-0">{item.meta}</span> : null}
              </button>
            </h3>
            <div
              id={`acc-panel-${item.id}`}
              role="region"
              aria-labelledby={`acc-trigger-${item.id}`}
              className={cx(
                "grid transition-[grid-template-rows] duration-base ease-emphasized",
                isOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
              )}
            >
              <div className="overflow-hidden">
                <div
                  className={cx(
                    "text-body text-content-muted",
                    size === "sm" ? "px-3 pb-2.5 pt-0" : "px-3.5 pb-3.5 pt-0",
                    "pl-9",
                  )}
                >
                  {item.content}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ==========================================================================
   ScrollArea
   ========================================================================== */

export interface ScrollAreaProps extends HTMLAttributes<HTMLDivElement> {
  orientation?: "vertical" | "horizontal" | "both";
  /** Convenience for `style={{ maxHeight }}`. */
  maxHeight?: number | string;
  /** Hide the scrollbar chrome but keep scrolling. */
  hideScrollbar?: boolean;
  /** Fade the content at the scrollable edges. */
  fade?: boolean;
  /** Ref onto the scrolling viewport itself. */
  viewportRef?: Ref<HTMLDivElement>;
}

export const ScrollArea = forwardRef<HTMLDivElement, ScrollAreaProps>(function ScrollArea(
  {
    orientation = "vertical",
    maxHeight,
    hideScrollbar = false,
    fade = false,
    viewportRef,
    className,
    style,
    children,
    ...rest
  },
  ref,
) {
  const innerRef = useRef<HTMLDivElement | null>(null);
  const setRefs = useCallback(
    (node: HTMLDivElement | null) => {
      innerRef.current = node;
      assignRef(ref, node);
      assignRef(viewportRef, node);
    },
    [ref, viewportRef],
  );

  return (
    <div
      ref={setRefs}
      style={{ maxHeight, ...style }}
      className={cx(
        "relative overscroll-contain",
        orientation === "vertical" && "overflow-y-auto overflow-x-hidden",
        orientation === "horizontal" && "overflow-x-auto overflow-y-hidden",
        orientation === "both" && "overflow-auto",
        hideScrollbar && "no-scrollbar",
        fade && (orientation === "horizontal" ? "mask-fade-x" : "mask-fade-y"),
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
});


/* ==========================================================================
   Modal — see ./overlays

   Modal, Dialog, Drawer, Sheet, ConfirmDialog, Tooltip and Popover live in
   `./overlays`, which owns every portalled surface (focus trap, scroll lock,
   scrim, Escape). The legacy `Modal` export is re-exported through the barrel
   from there, so `import { Modal } from "../ui"` keeps working unchanged.
   ========================================================================== */
