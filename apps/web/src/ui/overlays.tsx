/**
 * overlays.tsx — the overlay & feedback layer of the ConstructOS design system.
 *
 * Everything in this file obeys the same six rules:
 *
 *   1. It portals.            Overlays escape `overflow:hidden` ancestors.
 *   2. It traps focus.        Modal layers are inescapable by Tab; non-modal
 *                             layers return focus to their trigger.
 *   3. Escape closes the top. One global layer stack means a popover inside a
 *                             drawer inside a dialog unwinds one level per key
 *                             press — never all three at once.
 *   4. It locks scroll.       Reference-counted, so nesting cannot leak a lock.
 *   5. It respects motion.    Every variant collapses to a cross-fade (or
 *                             nothing) under `prefers-reduced-motion`.
 *   6. It is token-only.      No hex, no `z-[9999]`, no bespoke shadows.
 *
 * Positioning is @floating-ui/react. Animation is framer-motion (through
 * ./motion). Toasts are sonner, re-skinned onto our tokens. The command
 * surface is cmdk.
 *
 * Nothing here imports lucide-react, and nothing here hardcodes a colour.
 */
import {
  Component,
  cloneElement,
  createContext,
  createElement,
  forwardRef,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ButtonHTMLAttributes,
  ComponentPropsWithoutRef,
  CSSProperties,
  ErrorInfo,
  FocusEvent as ReactFocusEvent,
  HTMLProps,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactElement,
  ReactNode,
  Ref,
  RefObject,
} from "react";
import {
  FloatingArrow,
  FloatingDelayGroup,
  FloatingFocusManager,
  FloatingList,
  FloatingNode,
  FloatingOverlay,
  FloatingPortal,
  FloatingTree,
  arrow,
  autoUpdate,
  flip,
  offset,
  safePolygon,
  shift,
  size as floatingSize,
  useClick,
  useDismiss,
  useFloating,
  useFloatingNodeId,
  useFloatingParentNodeId,
  useFloatingTree,
  useFocus,
  useHover,
  useInteractions,
  useListItem,
  useListNavigation,
  useMergeRefs,
  useRole,
  useTypeahead,
} from "@floating-ui/react";
import type { Placement } from "@floating-ui/react";
import {
  Command as CmdkRoot,
  CommandEmpty as CmdkEmpty,
  CommandGroup as CmdkGroup,
  CommandInput as CmdkInput,
  CommandItem as CmdkItem,
  CommandList as CmdkList,
  CommandLoading as CmdkLoading,
  CommandSeparator as CmdkSeparator,
  useCommandState,
} from "cmdk";
import { Toaster as SonnerToaster, toast as sonnerToast } from "sonner";
import type { ExternalToast, ToasterProps as SonnerToasterProps } from "sonner";

import { cx } from "./cx";
import { Button, IconButton, Kbd } from "./primitives";
import type { IconLike } from "./primitives";
import {
  AnimatePresence,
  DURATION,
  EASE,
  drawerSlide,
  drawerSlideLeft,
  fade,
  modalPanel,
  motion,
  overlayFade,
  scaleIn,
  sheetSlide,
  useVariants,
} from "./motion";
import type { Variants } from "./motion";
import { Z, Z_CLASS, tone as toneStyles } from "./tokens";
import type { Tone } from "./tokens";
import { useResolvedTheme } from "../lib/theme";
import {
  IconAlert,
  IconCheck,
  IconCheckCircle,
  IconChevronRight,
  IconClose,
  IconCloseCircle,
  IconCopy,
  IconError,
  IconInfo,
  IconRefresh,
  IconSearch,
  IconSpinner,
  IconWarning,
  toneIcon,
} from "./icons";
import type { IconComponent } from "./icons";

/* ==========================================================================
   Shared types
========================================================================== */

/**
 * `IconLike` (an icon component from ./icons, or any node) is declared by
 * ./primitives and used verbatim here — one name, one declaration, so the ../ui
 * barrel's `export *` from both modules stays unambiguous.
 */

/** Re-exported so callers never have to import from @floating-ui/react. */
export type { Placement };

export type OverlayCloseReason =
  | "escape"
  | "outside-press"
  | "close-button"
  | "action"
  | "programmatic";

/* ==========================================================================
   Internal helpers
========================================================================== */

const noop = (): void => {};

/** Render an `IconLike` at a given size. Handles components *and* nodes. */
function renderIcon(icon: IconLike, size = 16, className?: string): ReactNode {
  if (icon === null || icon === undefined || typeof icon === "boolean") return null;
  if (isValidElement(icon)) return icon;
  if (typeof icon === "string" || typeof icon === "number") return icon;
  if (typeof icon === "function" || (typeof icon === "object" && "$$typeof" in icon)) {
    return createElement(icon as IconComponent, { size, className });
  }
  return icon as ReactNode;
}

/** Controlled-or-uncontrolled state in one hook. */
function useControllableState<T>(
  controlled: T | undefined,
  defaultValue: T,
  onChange?: (value: T) => void,
): [T, (value: T) => void] {
  const [uncontrolled, setUncontrolled] = useState<T>(defaultValue);
  const isControlled = controlled !== undefined;
  const value = isControlled ? controlled : uncontrolled;
  const handler = useRef(onChange);
  handler.current = onChange;
  const setValue = useCallback(
    (next: T) => {
      if (!isControlled) setUncontrolled(next);
      handler.current?.(next);
    },
    [isControlled],
  );
  return [value, setValue];
}

/** Latest-value ref, so effects never need the callback in their deps. */
function useEvent<A extends unknown[], R>(
  callback: ((...args: A) => R) | undefined,
): (...args: A) => R | undefined {
  const ref = useRef(callback);
  ref.current = callback;
  return useCallback((...args: A) => ref.current?.(...args), []);
}

/**
 * `bottom-start` → the panel should grow from its top-left corner.
 * Keeps scale-in animations anchored to the trigger instead of the centre.
 */
function transformOrigin(placement: Placement): string {
  const [side, alignment] = placement.split("-") as [string, string | undefined];
  if (side === "top" || side === "bottom") {
    const y = side === "top" ? "bottom" : "top";
    const x =
      alignment === "start" ? "left" : alignment === "end" ? "right" : "center";
    return `${x} ${y}`;
  }
  const x = side === "left" ? "right" : "left";
  const y =
    alignment === "start" ? "top" : alignment === "end" ? "bottom" : "center";
  return `${x} ${y}`;
}

/* ==========================================================================
   The layer stack — one Escape key, one winner
   --------------------------------------------------------------------------
   Every dismissible overlay registers here while it is open. A single
   capture-phase listener routes Escape to the *last* registered layer and stops
   the event, so nested overlays unwind one at a time. floating-ui's own
   `escapeKey` handling is disabled everywhere in this file in favour of it.
========================================================================== */

interface OverlayLayer {
  readonly onEscape: () => void;
}

const overlayLayers: OverlayLayer[] = [];
let escapeListenerBound = false;

function handleGlobalEscape(event: KeyboardEvent): void {
  if (event.key !== "Escape" || event.defaultPrevented) return;
  const top = overlayLayers[overlayLayers.length - 1];
  if (!top) return;
  event.preventDefault();
  event.stopPropagation();
  top.onEscape();
}

function bindEscapeListener(): void {
  if (escapeListenerBound || typeof document === "undefined") return;
  document.addEventListener("keydown", handleGlobalEscape, true);
  escapeListenerBound = true;
}

/**
 * Register an open overlay on the global Escape stack.
 *
 * Exported because feature code occasionally builds a bespoke overlay (a PDF
 * markup canvas, a 3D viewer HUD) that must participate in the same ordering.
 */
export function useOverlayEscape(
  active: boolean,
  onEscape: () => void,
  enabled = true,
): void {
  const handler = useRef(onEscape);
  handler.current = onEscape;
  useEffect(() => {
    if (!active || !enabled) return;
    const layer: OverlayLayer = { onEscape: () => handler.current() };
    overlayLayers.push(layer);
    bindEscapeListener();
    return () => {
      const index = overlayLayers.indexOf(layer);
      if (index !== -1) overlayLayers.splice(index, 1);
    };
  }, [active, enabled]);
}

/* ==========================================================================
   useDisclosure — the open/closed primitive every overlay in the app shares
========================================================================== */

export interface UseDisclosureOptions {
  /** Uncontrolled initial state. */
  defaultOpen?: boolean;
  /** Controlled state. When supplied, `open`/`close`/`toggle` only notify. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onOpen?: () => void;
  onClose?: () => void;
  /** Base id for `aria-controls` wiring. Generated when omitted. */
  id?: string;
}

export interface UseDisclosureReturn {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
  setOpen: (open: boolean) => void;
  /** Spread onto the element that opens the surface. */
  triggerProps: {
    "aria-expanded": boolean;
    "aria-controls": string;
    onClick: () => void;
  };
  /** Spread onto the surface itself. */
  contentProps: { id: string; hidden?: boolean };
  id: string;
}

/**
 * The one hook every overlay call site should use.
 *
 *   const dialog = useDisclosure();
 *   <Button {...dialog.triggerProps}>Open</Button>
 *   <Dialog open={dialog.isOpen} onOpenChange={dialog.setOpen} … />
 */
export function useDisclosure(
  options: UseDisclosureOptions | boolean = {},
): UseDisclosureReturn {
  const resolved: UseDisclosureOptions =
    typeof options === "boolean" ? { defaultOpen: options } : options;
  const { defaultOpen = false, open: controlled, onOpenChange, onOpen, onClose, id } = resolved;

  const generatedId = useId();
  const surfaceId = id ?? `disclosure-${generatedId}`;

  const [isOpen, setOpenState] = useControllableState(controlled, defaultOpen, onOpenChange);
  const emitOpen = useEvent(onOpen);
  const emitClose = useEvent(onClose);

  const setOpen = useCallback(
    (next: boolean) => {
      setOpenState(next);
      if (next) emitOpen();
      else emitClose();
    },
    [setOpenState, emitOpen, emitClose],
  );

  const open = useCallback(() => setOpen(true), [setOpen]);
  const close = useCallback(() => setOpen(false), [setOpen]);
  const toggle = useCallback(() => setOpen(!isOpen), [setOpen, isOpen]);

  return useMemo(
    () => ({
      isOpen,
      open,
      close,
      toggle,
      setOpen,
      id: surfaceId,
      triggerProps: {
        "aria-expanded": isOpen,
        "aria-controls": surfaceId,
        onClick: toggle,
      },
      contentProps: { id: surfaceId },
    }),
    [isOpen, open, close, toggle, setOpen, surfaceId],
  );
}

/* ==========================================================================
   useOverlayClose — let deep children dismiss their own surface
========================================================================== */

const OverlayCloseContext = createContext<(() => void) | null>(null);

/**
 * Returns a function that closes the nearest enclosing Dialog / Drawer /
 * Popover / Menu. Returns a no-op outside one, so it is always safe to call.
 */
export function useOverlayClose(): () => void {
  return useContext(OverlayCloseContext) ?? noop;
}

/* ==========================================================================
   Local controls
   --------------------------------------------------------------------------
   Overlays own a handful of chrome controls — the header ✕, the ConfirmDialog
   action pair, the tour footer. They are built from the same token recipe the
   shared Button uses so they stay visually identical, but they live here so
   this module has no dependency edge into the primitives layer.
========================================================================== */

/** "⌘+K" → ["⌘", "K"]. A leading "+" is a key, not a separator. */
function splitShortcut(keys: string): string[] {
  return keys.split(/(?<!^)\+/g).filter(Boolean);
}

/** The ✕ in a Dialog / Drawer / Coachmark header. */
function OverlayCloseButton({
  onClick,
  label = "Close",
  className,
}: {
  onClick: () => void;
  label?: string;
  className?: string;
}) {
  return (
    <IconButton
      icon={IconClose}
      label={label}
      variant="ghost"
      size="sm"
      hideTitle
      onClick={onClick}
      className={cx("shrink-0 text-content-subtle hover:text-content", className)}
    />
  );
}

/** Right-aligned keycap cluster for menu rows and command items. */
function ShortcutKeys({ keys, className }: { keys: string; className?: string }) {
  return (
    <Kbd keys={splitShortcut(keys)} size="xs" className={cx("ml-auto shrink-0 pl-3", className)} />
  );
}

/* ==========================================================================
   Shared surface recipes for this module
========================================================================== */

/** Menus, popovers, hover cards, command lists. */
const FLOATING_PANEL =
  "rounded-lg border border-border bg-surface-overlay shadow-e3 " +
  "supports-[backdrop-filter]:bg-surface-overlay/95 supports-[backdrop-filter]:backdrop-blur-xl";

/** Dialogs and drawers. */
const MODAL_PANEL =
  "relative flex flex-col overflow-hidden border border-border bg-surface-overlay shadow-e5";

const SCRIM = "bg-scrim supports-[backdrop-filter]:backdrop-blur-[3px]";

/* ==========================================================================
   Dialog
   --------------------------------------------------------------------------
   The centred, modal, focus-trapped surface. Header / body / footer are
   composable, but the common case is fully declarative:

     <Dialog open={d.isOpen} onOpenChange={d.setOpen}
             title="Issue change order" description="CO-114 · Level 3 slab"
             footer={<>…</>}>
       …
     </Dialog>
========================================================================== */

export type DialogSize = "xs" | "sm" | "md" | "lg" | "xl" | "2xl" | "full" | "fullscreen";

const DIALOG_WIDTH: Record<DialogSize, string> = {
  xs: "max-w-sm",
  sm: "max-w-md",
  /** Matches the historic default Modal width. */
  md: "max-w-lg",
  /** Matches the historic `wide` Modal width. */
  lg: "max-w-3xl",
  xl: "max-w-5xl",
  "2xl": "max-w-7xl",
  full: "max-w-[calc(100vw-3rem)]",
  fullscreen: "max-w-none",
};

export interface DialogProps {
  open: boolean;
  /** Preferred. Fires with `false` on Escape, scrim click, or the ✕. */
  onOpenChange?: (open: boolean, reason?: OverlayCloseReason) => void;
  /** Convenience alias for `onOpenChange(false)`. */
  onClose?: (reason?: OverlayCloseReason) => void;

  size?: DialogSize;
  /** Vertical placement of the panel within the viewport. */
  align?: "center" | "top";

  title?: ReactNode;
  description?: ReactNode;
  /** Component from ./icons or an element. Rendered in a tinted tile. */
  icon?: IconLike;
  /** Colours the icon tile. Defaults to `accent` when an icon is present. */
  tone?: Tone;
  /** Extra controls rendered in the header, left of the ✕. */
  headerActions?: ReactNode;
  /** Replaces the whole default header. */
  header?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;

  showCloseButton?: boolean;
  closeOnOverlayClick?: boolean;
  closeOnEscape?: boolean;
  /** Turns off *both* Escape and scrim dismissal — for unsaved-work guards. */
  dismissible?: boolean;

  initialFocus?: number | RefObject<HTMLElement | null>;
  returnFocus?: boolean;
  /** Skip body scroll locking (rare — e.g. a dialog over a virtualised list). */
  preventScrollLock?: boolean;

  className?: string;
  overlayClassName?: string;
  headerClassName?: string;
  bodyClassName?: string;
  footerClassName?: string;
  /** Removes the default body padding, for edge-to-edge content. */
  unpaddedBody?: boolean;

  id?: string;
  "aria-label"?: string;
  zIndex?: number;
  /** Portal container id. Overlays share one node by default. */
  portalId?: string;
}

export const OVERLAY_PORTAL_ID = "constructos-overlays";

export function Dialog({
  open,
  onOpenChange,
  onClose,
  size = "md",
  align = "center",
  title,
  description,
  icon,
  tone,
  headerActions,
  header,
  footer,
  children,
  showCloseButton = true,
  closeOnOverlayClick = true,
  closeOnEscape = true,
  dismissible = true,
  initialFocus,
  returnFocus = true,
  preventScrollLock = false,
  className,
  overlayClassName,
  headerClassName,
  bodyClassName,
  footerClassName,
  unpaddedBody = false,
  id,
  "aria-label": ariaLabel,
  zIndex,
  portalId = OVERLAY_PORTAL_ID,
}: DialogProps) {
  const generatedId = useId();
  const baseId = id ?? `dialog-${generatedId}`;
  const titleId = `${baseId}-title`;
  const descriptionId = `${baseId}-description`;

  const emitOpenChange = useEvent(onOpenChange);
  const emitClose = useEvent(onClose);

  const requestClose = useCallback(
    (reason: OverlayCloseReason) => {
      emitOpenChange(false, reason);
      emitClose(reason);
    },
    [emitOpenChange, emitClose],
  );

  const { refs, context } = useFloating({
    open,
    onOpenChange: (next, _event, reason) => {
      if (next) {
        emitOpenChange(true, "programmatic");
        return;
      }
      requestClose(reason === "outside-press" ? "outside-press" : "programmatic");
    },
  });

  const dismiss = useDismiss(context, {
    // Escape is owned by the global layer stack so nesting unwinds correctly.
    escapeKey: false,
    outsidePress: dismissible && closeOnOverlayClick,
    outsidePressEvent: "mousedown",
  });
  const role = useRole(context, { role: "dialog" });
  const { getFloatingProps } = useInteractions([dismiss, role]);

  useOverlayEscape(open, () => requestClose("escape"), dismissible && closeOnEscape);

  const closeFromButton = useCallback(() => requestClose("close-button"), [requestClose]);

  const panelVariants = useVariants(modalPanel);
  const scrimVariants = useVariants(overlayFade);

  const isFullscreen = size === "fullscreen";
  const hasHeader = header !== undefined || title !== undefined || showCloseButton;

  return (
    <AnimatePresence>
      {open ? (
        <FloatingPortal key="dialog" id={portalId}>
          <FloatingOverlay
            lockScroll={!preventScrollLock}
            className={cx(Z_CLASS.modal, "overscroll-contain", overlayClassName)}
            style={zIndex === undefined ? undefined : { zIndex }}
          >
            <motion.div
              aria-hidden
              variants={scrimVariants}
              initial="hidden"
              animate="visible"
              exit="exit"
              className={cx("fixed inset-0", SCRIM)}
            />
            <div
              className={cx(
                "relative flex min-h-full w-full justify-center",
                isFullscreen ? "p-0" : "p-4 sm:p-6",
                align === "top" ? "items-start pt-[8vh]" : "items-center",
              )}
            >
              <FloatingFocusManager
                context={context}
                modal
                initialFocus={initialFocus}
                returnFocus={returnFocus}
                visuallyHiddenDismiss="Close dialog"
              >
                <div
                  ref={refs.setFloating}
                  {...getFloatingProps()}
                  {...(title === undefined ? {} : { "aria-labelledby": titleId })}
                  {...(description === undefined ? {} : { "aria-describedby": descriptionId })}
                  {...(ariaLabel === undefined ? {} : { "aria-label": ariaLabel })}
                  aria-modal="true"
                  className={cx("w-full", isFullscreen ? "h-[100dvh]" : DIALOG_WIDTH[size])}
                >
                  <motion.div
                    variants={panelVariants}
                    initial="hidden"
                    animate="visible"
                    exit="exit"
                    className={cx(
                      MODAL_PANEL,
                      isFullscreen
                        ? "h-full rounded-none border-0"
                        : "max-h-[calc(100dvh-3rem)] rounded-xl",
                      className,
                    )}
                  >
                    <OverlayCloseContext.Provider value={closeFromButton}>
                      {header ?? (
                        hasHeader ? (
                          <DialogHeader
                            title={title}
                            description={description}
                            icon={icon}
                            tone={tone}
                            titleId={titleId}
                            descriptionId={descriptionId}
                            actions={headerActions}
                            onClose={showCloseButton ? closeFromButton : undefined}
                            className={headerClassName}
                          />
                        ) : null
                      )}
                      <DialogBody unpadded={unpaddedBody} className={bodyClassName}>
                        {children}
                      </DialogBody>
                      {footer ? (
                        <DialogFooter className={footerClassName}>{footer}</DialogFooter>
                      ) : null}
                    </OverlayCloseContext.Provider>
                  </motion.div>
                </div>
              </FloatingFocusManager>
            </div>
          </FloatingOverlay>
        </FloatingPortal>
      ) : null}
    </AnimatePresence>
  );
}

export interface DialogHeaderProps {
  title?: ReactNode;
  description?: ReactNode;
  icon?: IconLike;
  tone?: Tone;
  actions?: ReactNode;
  onClose?: () => void;
  closeLabel?: string;
  titleId?: string;
  descriptionId?: string;
  className?: string;
  children?: ReactNode;
}

export function DialogHeader({
  title,
  description,
  icon,
  tone,
  actions,
  onClose,
  closeLabel,
  titleId,
  descriptionId,
  className,
  children,
}: DialogHeaderProps) {
  const resolvedTone: Tone = tone ?? "accent";
  const iconNode = renderIcon(icon, 17);
  return (
    <header
      className={cx(
        "flex shrink-0 items-start gap-3 border-b border-border px-5 py-4",
        className,
      )}
    >
      {iconNode ? (
        <span
          className={cx(
            "mt-px grid size-8 shrink-0 place-items-center rounded-lg",
            toneStyles[resolvedTone].subtle,
          )}
        >
          {iconNode}
        </span>
      ) : null}
      <div className="min-w-0 flex-1">
        {title !== undefined ? (
          <h2
            id={titleId}
            className="truncate text-base font-semibold tracking-[-0.011em] text-content"
          >
            {title}
          </h2>
        ) : null}
        {description !== undefined ? (
          <p id={descriptionId} className="mt-1 text-body text-content-muted">
            {description}
          </p>
        ) : null}
        {children}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
      {onClose ? (
        <OverlayCloseButton onClick={onClose} label={closeLabel} className="-mr-1.5" />
      ) : null}
    </header>
  );
}

export interface DialogBodyProps {
  children?: ReactNode;
  className?: string;
  unpadded?: boolean;
}

export function DialogBody({ children, className, unpadded = false }: DialogBodyProps) {
  return (
    <div
      className={cx(
        "min-h-0 flex-1 overflow-y-auto overscroll-contain",
        unpadded ? "" : "px-5 py-4",
        className,
      )}
    >
      {children}
    </div>
  );
}

export interface DialogFooterProps {
  children?: ReactNode;
  className?: string;
  /** `end` (default) right-aligns actions; `between` splits them apart. */
  align?: "end" | "start" | "between" | "center";
}

const FOOTER_ALIGN: Record<NonNullable<DialogFooterProps["align"]>, string> = {
  end: "justify-end",
  start: "justify-start",
  between: "justify-between",
  center: "justify-center",
};

export function DialogFooter({ children, className, align = "end" }: DialogFooterProps) {
  return (
    <footer
      className={cx(
        "flex shrink-0 flex-wrap items-center gap-2 border-t border-border",
        "bg-surface-sunken/60 px-5 py-3.5",
        FOOTER_ALIGN[align],
        className,
      )}
    >
      {children}
    </footer>
  );
}

/** Dismisses the enclosing overlay. Handy inside `footer` slots. */
export interface DialogCloseProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children?: ReactNode;
}

export const DialogClose = forwardRef<HTMLButtonElement, DialogCloseProps>(
  function DialogClose({ onClick, children, ...rest }, ref) {
    const close = useOverlayClose();
    return (
      <Button
        ref={ref}
        variant="secondary"
        onClick={(event) => {
          onClick?.(event);
          if (!event.defaultPrevented) close();
        }}
        {...rest}
      >
        {children ?? "Close"}
      </Button>
    );
  },
);

/* ==========================================================================
   Modal — the legacy surface, unchanged in signature
   --------------------------------------------------------------------------
   ~89k lines of pages call this as:
       <Modal open={x} title="…" onClose={fn} wide>{children}</Modal>
   That contract is frozen. Everything below `wide` is additive.
========================================================================== */

export interface ModalProps {
  open: boolean;
  /** Historically `string`; widened to ReactNode, which every string satisfies. */
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** Legacy width switch. Equivalent to `size="lg"`. */
  wide?: boolean;

  /* --- additive --------------------------------------------------------- */
  size?: DialogSize;
  description?: ReactNode;
  icon?: IconLike;
  tone?: Tone;
  footer?: ReactNode;
  headerActions?: ReactNode;
  showCloseButton?: boolean;
  closeOnOverlayClick?: boolean;
  closeOnEscape?: boolean;
  dismissible?: boolean;
  align?: "center" | "top";
  initialFocus?: number | RefObject<HTMLElement | null>;
  className?: string;
  bodyClassName?: string;
  unpaddedBody?: boolean;
  "aria-label"?: string;
}

export function Modal({
  open,
  title,
  onClose,
  children,
  wide = false,
  size,
  ...rest
}: ModalProps) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      size={size ?? (wide ? "lg" : "md")}
      {...rest}
    >
      {children}
    </Dialog>
  );
}

/* ==========================================================================
   ConfirmDialog
   --------------------------------------------------------------------------
   The destructive-action gate. Two levels of friction:
     • `tone="danger"` — red action button, warning tile.
     • `confirmationText` — the user must type the exact string first. Use it
       whenever the action is irreversible and scoped to a named record
       ("Delete drawing set A-201").
========================================================================== */

const OVERLAY_INPUT =
  "block h-control w-full rounded-md border border-border bg-surface-raised px-3 " +
  "text-body text-content transition-colors duration-fast " +
  "placeholder:text-content-subtle hover:border-border-strong " +
  "focus:border-accent focus:bg-surface-raised " +
  "disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-content-disabled";

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange?: (open: boolean, reason?: OverlayCloseReason) => void;
  onClose?: (reason?: OverlayCloseReason) => void;

  title: ReactNode;
  description?: ReactNode;
  /** Extra content between the description and the confirmation input. */
  children?: ReactNode;

  /**
   * Return `false` (or a promise of it) to keep the dialog open — e.g. the
   * request failed. Throwing surfaces the message inline instead of closing.
   */
  onConfirm: () => void | boolean | Promise<void | boolean>;
  onCancel?: () => void;

  confirmLabel?: ReactNode;
  cancelLabel?: ReactNode;
  hideCancel?: boolean;

  tone?: Tone;
  /** Shorthand for `tone="danger"`. */
  destructive?: boolean;
  icon?: IconLike;
  size?: DialogSize;

  /** When set, the confirm button stays disabled until this is typed exactly. */
  confirmationText?: string;
  confirmationLabel?: ReactNode;
  confirmationPlaceholder?: string;

  /** External busy state, ORed with the internal one. */
  loading?: boolean;
  /** Close automatically once `onConfirm` resolves. Default `true`. */
  closeOnConfirm?: boolean;
  dismissible?: boolean;
  /** Default `false` — Cancel is the affordance, a ✕ is redundant here. */
  showCloseButton?: boolean;
  className?: string;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  onClose,
  title,
  description,
  children,
  onConfirm,
  onCancel,
  confirmLabel,
  cancelLabel = "Cancel",
  hideCancel = false,
  tone,
  destructive = false,
  icon,
  size = "sm",
  confirmationText,
  confirmationLabel,
  confirmationPlaceholder,
  loading = false,
  closeOnConfirm = true,
  dismissible = true,
  showCloseButton = false,
  className,
}: ConfirmDialogProps) {
  const resolvedTone: Tone = tone ?? (destructive ? "danger" : "accent");
  const isDanger = resolvedTone === "danger";

  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const confirmationInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setTyped("");
    setBusy(false);
    setError(null);
  }, [open]);

  const emitOpenChange = useEvent(onOpenChange);
  const emitClose = useEvent(onClose);
  const emitCancel = useEvent(onCancel);

  const close = useCallback(
    (reason: OverlayCloseReason) => {
      emitOpenChange(false, reason);
      emitClose(reason);
    },
    [emitOpenChange, emitClose],
  );

  const handleCancel = useCallback(() => {
    emitCancel();
    close("action");
  }, [emitCancel, close]);

  const needsTyping = confirmationText !== undefined && confirmationText.length > 0;
  const typedMatches = !needsTyping || typed.trim() === confirmationText.trim();
  const isBusy = busy || loading;
  const canConfirm = typedMatches && !isBusy;

  const runConfirm = useCallback(async () => {
    if (!canConfirm) return;
    setError(null);
    setBusy(true);
    try {
      const result = await onConfirm();
      if (result === false) {
        setBusy(false);
        return;
      }
      setBusy(false);
      if (closeOnConfirm) close("action");
    } catch (caught) {
      setBusy(false);
      setError(caught instanceof Error ? caught.message : "Something went wrong. Try again.");
    }
  }, [canConfirm, onConfirm, closeOnConfirm, close]);

  const defaultIcon: IconLike = icon ?? (isDanger ? IconAlert : toneIcon(resolvedTone));

  return (
    <Dialog
      open={open}
      size={size}
      tone={resolvedTone}
      icon={defaultIcon}
      title={title}
      description={description}
      dismissible={dismissible && !isBusy}
      showCloseButton={showCloseButton}
      initialFocus={needsTyping ? confirmationInputRef : undefined}
      className={className}
      onOpenChange={(next, reason) => {
        if (!next) {
          emitCancel();
          close(reason ?? "programmatic");
        }
      }}
      footer={
        <>
          {hideCancel ? null : (
            <Button variant="ghost" onClick={handleCancel} disabled={isBusy}>
              {cancelLabel}
            </Button>
          )}
          <Button
            variant={isDanger ? "danger" : "primary"}
            onClick={() => void runConfirm()}
            disabled={!canConfirm}
            loading={isBusy}
          >
            {confirmLabel ?? (isDanger ? "Delete" : "Confirm")}
          </Button>
        </>
      }
    >
      {children}
      {needsTyping ? (
        <div className={cx(children ? "mt-4" : "")}>
          <label htmlFor={inputId} className="block text-meta text-content-muted">
            {confirmationLabel ?? (
              <>
                Type{" "}
                <code className="rounded-xs bg-code-bg px-1 py-0.5 font-mono text-code text-content">
                  {confirmationText}
                </code>{" "}
                to confirm.
              </>
            )}
          </label>
          <input
            ref={confirmationInputRef}
            id={inputId}
            value={typed}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            disabled={isBusy}
            placeholder={confirmationPlaceholder ?? confirmationText}
            aria-invalid={typed.length > 0 && !typedMatches}
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && canConfirm) {
                event.preventDefault();
                void runConfirm();
              }
            }}
            className={cx(
              "mt-2 font-mono text-code",
              OVERLAY_INPUT,
              typed.length > 0 && !typedMatches ? "border-danger-border" : "",
            )}
          />
        </div>
      ) : null}
      {error ? (
        <div
          role="alert"
          className={cx(
            "mt-4 flex items-start gap-2 rounded-md px-3 py-2 text-body",
            toneStyles.danger.subtle,
          )}
        >
          <IconCloseCircle size={15} className="mt-0.5 shrink-0" />
          <span className="min-w-0">{error}</span>
        </div>
      ) : null}
    </Dialog>
  );
}

/* --------------------------------------------------------------------------
   useConfirm — promise-based confirmation without wiring up state by hand
-------------------------------------------------------------------------- */

export type ConfirmOptions = Omit<
  ConfirmDialogProps,
  "open" | "onOpenChange" | "onClose" | "onConfirm"
> & {
  /** Optional side effect run before the promise resolves `true`. */
  onConfirm?: () => void | boolean | Promise<void | boolean>;
};

export interface UseConfirmReturn {
  /** Resolves `true` when confirmed, `false` when cancelled or dismissed. */
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  /** Render this once, anywhere in the subtree. */
  dialog: ReactNode;
}

/**
 *   const { confirm, dialog } = useConfirm();
 *   …
 *   if (await confirm({ title: "Void this invoice?", destructive: true })) { … }
 *   …
 *   return <>{dialog}…</>;
 */
export function useConfirm(): UseConfirmReturn {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((value: boolean) => void) | null>(null);

  const settle = useCallback((value: boolean) => {
    const resolve = resolver.current;
    resolver.current = null;
    setOpen(false);
    resolve?.(value);
  }, []);

  const confirm = useCallback(
    (next: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        resolver.current?.(false);
        resolver.current = resolve;
        setOptions(next);
        setOpen(true);
      }),
    [],
  );

  useEffect(() => () => resolver.current?.(false), []);

  const dialog = options ? (
    <ConfirmDialog
      {...options}
      open={open}
      onOpenChange={(next) => {
        if (!next) settle(false);
      }}
      onConfirm={async () => {
        const result = await options.onConfirm?.();
        if (result === false) return false;
        settle(true);
        return true;
      }}
      closeOnConfirm={false}
    />
  ) : null;

  return { confirm, dialog };
}

/* ==========================================================================
   Drawer / Sheet
   --------------------------------------------------------------------------
   Edge-anchored panels. `right` is the workhorse (record inspectors, filter
   panels), `left` is navigation, `bottom` is the mobile sheet.

   Three things make this more than a slide-in div:
     • Resizable — drag the inner edge, keyboard-adjustable, optionally
       persisted per key so a user's preferred inspector width sticks.
     • Stackable — a Drawer opened from inside a Drawer insets from the same
       edge so the parent stays legible behind it.
     • Non-modal mode — `modal={false}` keeps the page interactive, which is
       what an inspector docked beside a table actually wants.
========================================================================== */

export type DrawerSide = "right" | "left" | "bottom" | "top";
export type DrawerSize = "sm" | "md" | "lg" | "xl" | "full";

const DRAWER_INLINE_SIZE: Record<DrawerSize, string> = {
  sm: "w-screen max-w-sm",
  md: "w-screen max-w-drawer",
  lg: "w-screen max-w-drawer-wide",
  xl: "w-screen max-w-[60rem]",
  full: "w-screen",
};

const DRAWER_BLOCK_SIZE: Record<DrawerSize, string> = {
  sm: "h-auto max-h-[40dvh]",
  md: "h-auto max-h-[60dvh]",
  lg: "h-auto max-h-[80dvh]",
  xl: "h-auto max-h-[92dvh]",
  full: "h-[100dvh]",
};

const drawerSlideTop: Variants = {
  hidden: { y: "-100%" },
  visible: { y: 0, transition: { duration: DURATION.slow, ease: EASE.emphasized } },
  exit: { y: "-100%", transition: { duration: DURATION.base, ease: EASE.accelerate } },
};

const DRAWER_VARIANTS: Record<DrawerSide, Variants> = {
  right: drawerSlide,
  left: drawerSlideLeft,
  bottom: sheetSlide,
  top: drawerSlideTop,
};

const DRAWER_ANCHOR: Record<DrawerSide, string> = {
  right: "inset-y-0 right-0",
  left: "inset-y-0 left-0",
  bottom: "inset-x-0 bottom-0",
  top: "inset-x-0 top-0",
};

/** Flush against its edge: no border or radius on the side that touches it. */
const DRAWER_RADIUS: Record<DrawerSide, string> = {
  right: "rounded-l-xl border-y-0 border-r-0",
  left: "rounded-r-xl border-y-0 border-l-0",
  bottom: "rounded-t-2xl border-x-0 border-b-0",
  top: "rounded-b-2xl border-x-0 border-t-0",
};

/** Stacked (inset from the edge): fully bordered and rounded on both ends. */
const DRAWER_RADIUS_STACKED: Record<DrawerSide, string> = {
  right: "rounded-l-xl rounded-r-none border",
  left: "rounded-r-xl rounded-l-none border",
  bottom: "rounded-t-2xl border",
  top: "rounded-b-2xl border",
};

/** Nesting depth, so a Drawer opened inside a Drawer knows to inset. */
const DrawerDepthContext = createContext(0);

const DRAWER_STACK_INSET = 26;

function readStoredSize(key: string | undefined): number | null {
  if (!key || typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(`constructos:drawer:${key}`);
    if (!raw) return null;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function writeStoredSize(key: string | undefined, value: number | null): void {
  if (!key || typeof window === "undefined") return;
  try {
    if (value === null) window.localStorage.removeItem(`constructos:drawer:${key}`);
    else window.localStorage.setItem(`constructos:drawer:${key}`, String(value));
  } catch {
    /* storage unavailable — the drag still works for this session */
  }
}

export interface DrawerProps {
  open: boolean;
  onOpenChange?: (open: boolean, reason?: OverlayCloseReason) => void;
  onClose?: (reason?: OverlayCloseReason) => void;

  side?: DrawerSide;
  size?: DrawerSize;
  /** Static override. Wins over `size`; ignored while a resize is in effect. */
  width?: number | string;

  /** Adds a drag handle on the inner edge (width for left/right, height for top/bottom). */
  resizable?: boolean;
  minSize?: number;
  maxSize?: number;
  defaultSize?: number;
  onResize?: (size: number) => void;
  /** Persist the dragged size under this key. */
  resizeStorageKey?: string;

  title?: ReactNode;
  description?: ReactNode;
  icon?: IconLike;
  tone?: Tone;
  /** Replaces the default header entirely. */
  header?: ReactNode;
  headerActions?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;

  showCloseButton?: boolean;
  /** `false` leaves the page interactive and skips the scrim + scroll lock. */
  modal?: boolean;
  /** Force the scrim independently of `modal`. */
  overlay?: boolean;
  closeOnOverlayClick?: boolean;
  closeOnEscape?: boolean;
  dismissible?: boolean;

  initialFocus?: number | RefObject<HTMLElement | null>;
  returnFocus?: boolean;

  className?: string;
  overlayClassName?: string;
  headerClassName?: string;
  bodyClassName?: string;
  footerClassName?: string;
  unpaddedBody?: boolean;

  id?: string;
  "aria-label"?: string;
  zIndex?: number;
  portalId?: string;
}

export function Drawer({
  open,
  onOpenChange,
  onClose,
  side = "right",
  size = "md",
  width,
  resizable = false,
  minSize = 320,
  maxSize = 1100,
  defaultSize,
  onResize,
  resizeStorageKey,
  title,
  description,
  icon,
  tone,
  header,
  headerActions,
  footer,
  children,
  showCloseButton = true,
  modal = true,
  overlay,
  closeOnOverlayClick = true,
  closeOnEscape = true,
  dismissible = true,
  initialFocus,
  returnFocus = true,
  className,
  overlayClassName,
  headerClassName,
  bodyClassName,
  footerClassName,
  unpaddedBody = false,
  id,
  "aria-label": ariaLabel,
  zIndex,
  portalId = OVERLAY_PORTAL_ID,
}: DrawerProps) {
  const depth = useContext(DrawerDepthContext);
  const generatedId = useId();
  const baseId = id ?? `drawer-${generatedId}`;
  const titleId = `${baseId}-title`;
  const descriptionId = `${baseId}-description`;

  const isHorizontal = side === "left" || side === "right";
  const showScrim = overlay ?? modal;

  const emitOpenChange = useEvent(onOpenChange);
  const emitClose = useEvent(onClose);
  const emitResize = useEvent(onResize);

  const requestClose = useCallback(
    (reason: OverlayCloseReason) => {
      emitOpenChange(false, reason);
      emitClose(reason);
    },
    [emitOpenChange, emitClose],
  );

  const { refs, context } = useFloating({
    open,
    onOpenChange: (next, _event, reason) => {
      if (next) {
        emitOpenChange(true, "programmatic");
        return;
      }
      requestClose(reason === "outside-press" ? "outside-press" : "programmatic");
    },
  });

  const dismiss = useDismiss(context, {
    escapeKey: false,
    outsidePress: dismissible && closeOnOverlayClick && showScrim,
    outsidePressEvent: "mousedown",
  });
  const role = useRole(context, { role: "dialog" });
  const { getFloatingProps } = useInteractions([dismiss, role]);

  useOverlayEscape(open, () => requestClose("escape"), dismissible && closeOnEscape);

  const closeFromButton = useCallback(() => requestClose("close-button"), [requestClose]);

  /* ---------------------------------------------------------------- resize */
  const [draggedSize, setDraggedSize] = useState<number | null>(
    () => defaultSize ?? readStoredSize(resizeStorageKey),
  );
  const [isResizing, setIsResizing] = useState(false);
  const dragState = useRef<{ origin: number; start: number } | null>(null);

  const clamp = useCallback(
    (value: number) => Math.min(Math.max(value, minSize), maxSize),
    [minSize, maxSize],
  );

  const commitSize = useCallback(
    (value: number) => {
      const next = clamp(Math.round(value));
      setDraggedSize(next);
      emitResize(next);
      writeStoredSize(resizeStorageKey, next);
    },
    [clamp, emitResize, resizeStorageKey],
  );

  const handleResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const panel = refs.floating.current;
      if (!panel) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      const rect = panel.getBoundingClientRect();
      dragState.current = {
        origin: isHorizontal ? event.clientX : event.clientY,
        start: isHorizontal ? rect.width : rect.height,
      };
      setIsResizing(true);
    },
    [refs.floating, isHorizontal],
  );

  const handleResizePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const state = dragState.current;
      if (!state) return;
      const position = isHorizontal ? event.clientX : event.clientY;
      const delta = position - state.origin;
      const grows = side === "right" || side === "bottom" ? -delta : delta;
      commitSize(state.start + grows);
    },
    [isHorizontal, side, commitSize],
  );

  const endResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    dragState.current = null;
    setIsResizing(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const handleResizeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const panel = refs.floating.current;
      if (!panel) return;
      const step = event.shiftKey ? 64 : 16;
      const rect = panel.getBoundingClientRect();
      const current = isHorizontal ? rect.width : rect.height;
      const grow = isHorizontal ? "ArrowLeft" : "ArrowUp";
      const shrink = isHorizontal ? "ArrowRight" : "ArrowDown";
      const growKey = side === "right" || side === "bottom" ? grow : shrink;
      const shrinkKey = side === "right" || side === "bottom" ? shrink : grow;
      if (event.key === growKey) {
        event.preventDefault();
        commitSize(current + step);
      } else if (event.key === shrinkKey) {
        event.preventDefault();
        commitSize(current - step);
      } else if (event.key === "Home") {
        event.preventDefault();
        commitSize(minSize);
      } else if (event.key === "End") {
        event.preventDefault();
        commitSize(maxSize);
      }
    },
    [refs.floating, isHorizontal, side, commitSize, minSize, maxSize],
  );

  useEffect(() => {
    if (!isResizing || typeof document === "undefined") return;
    const previousCursor = document.body.style.cursor;
    const previousSelect = document.body.style.userSelect;
    document.body.style.cursor = isHorizontal ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelect;
    };
  }, [isResizing, isHorizontal]);

  /* --------------------------------------------------------------- render */
  const panelVariants = useVariants(DRAWER_VARIANTS[side]);
  const scrimVariants = useVariants(overlayFade);

  const stackInset = isHorizontal ? depth * DRAWER_STACK_INSET : 0;
  const activeSize = resizable ? draggedSize : null;

  const panelStyle: CSSProperties = {};
  if (side === "right") panelStyle.right = stackInset;
  if (side === "left") panelStyle.left = stackInset;
  if (activeSize !== null) {
    if (isHorizontal) panelStyle.width = activeSize;
    else panelStyle.height = activeSize;
  } else if (width !== undefined) {
    if (isHorizontal) panelStyle.width = width;
    else panelStyle.height = width;
  }
  if (stackInset > 0 && isHorizontal) {
    panelStyle.maxWidth = `calc(100vw - ${stackInset}px)`;
  }

  const sizeClass = activeSize !== null || width !== undefined
    ? isHorizontal
      ? "max-w-none"
      : "max-h-none"
    : isHorizontal
      ? DRAWER_INLINE_SIZE[size]
      : DRAWER_BLOCK_SIZE[size];

  const hasHeader = header !== undefined || title !== undefined || showCloseButton;

  return (
    <AnimatePresence>
      {open ? (
        <FloatingPortal key="drawer" id={portalId}>
          <FloatingOverlay
            lockScroll={modal}
            className={cx(
              Z_CLASS.modal,
              modal ? "" : "pointer-events-none",
              "overflow-hidden",
              overlayClassName,
            )}
            style={{ zIndex: zIndex ?? Z.modal + depth }}
          >
            {showScrim ? (
              <motion.div
                aria-hidden
                variants={scrimVariants}
                initial="hidden"
                animate="visible"
                exit="exit"
                className={cx("absolute inset-0", depth > 0 ? "bg-scrim/70" : SCRIM)}
              />
            ) : null}

            <FloatingFocusManager
              context={context}
              modal={modal}
              initialFocus={initialFocus}
              returnFocus={returnFocus}
              closeOnFocusOut={false}
              visuallyHiddenDismiss="Close panel"
            >
              <div
                ref={refs.setFloating}
                {...getFloatingProps()}
                {...(title === undefined ? {} : { "aria-labelledby": titleId })}
                {...(description === undefined ? {} : { "aria-describedby": descriptionId })}
                {...(ariaLabel === undefined ? {} : { "aria-label": ariaLabel })}
                {...(modal ? { "aria-modal": "true" as const } : {})}
                style={panelStyle}
                className={cx(
                  "pointer-events-auto absolute flex",
                  DRAWER_ANCHOR[side],
                  isHorizontal ? "h-full" : "w-full",
                  sizeClass,
                )}
              >
                <motion.div
                  variants={panelVariants}
                  initial="hidden"
                  animate="visible"
                  exit="exit"
                  className={cx(
                    MODAL_PANEL,
                    "h-full w-full border-border",
                    stackInset > 0 ? DRAWER_RADIUS_STACKED[side] : DRAWER_RADIUS[side],
                    isResizing ? "select-none" : "",
                    className,
                  )}
                >
                  <OverlayCloseContext.Provider value={closeFromButton}>
                    <DrawerDepthContext.Provider value={depth + 1}>
                      {resizable ? (
                        <div
                          role="separator"
                          tabIndex={0}
                          aria-orientation={isHorizontal ? "vertical" : "horizontal"}
                          aria-label="Resize panel"
                          aria-valuemin={minSize}
                          aria-valuemax={maxSize}
                          aria-valuenow={activeSize ?? undefined}
                          onPointerDown={handleResizePointerDown}
                          onPointerMove={handleResizePointerMove}
                          onPointerUp={endResize}
                          onPointerCancel={endResize}
                          onKeyDown={handleResizeKeyDown}
                          onDoubleClick={() => {
                            setDraggedSize(null);
                            writeStoredSize(resizeStorageKey, null);
                          }}
                          className={cx(
                            "group absolute z-20 flex items-center justify-center",
                            isHorizontal
                              ? "inset-y-0 w-2 cursor-col-resize"
                              : "inset-x-0 h-2 cursor-row-resize",
                            side === "right" ? "left-0" : "",
                            side === "left" ? "right-0" : "",
                            side === "bottom" ? "top-0" : "",
                            side === "top" ? "bottom-0" : "",
                          )}
                        >
                          <span
                            aria-hidden
                            className={cx(
                              "rounded-full bg-border-strong opacity-0 transition-opacity duration-fast",
                              "group-hover:opacity-100 group-focus-visible:opacity-100",
                              isResizing ? "opacity-100" : "",
                              isHorizontal ? "h-10 w-[3px]" : "h-[3px] w-10",
                            )}
                          />
                        </div>
                      ) : null}

                      {side === "bottom" ? (
                        <div aria-hidden className="flex shrink-0 justify-center pt-2.5 pb-1">
                          <span className="h-1 w-9 rounded-full bg-border-strong" />
                        </div>
                      ) : null}

                      {header ?? (
                        hasHeader ? (
                          <DrawerHeader
                            title={title}
                            description={description}
                            icon={icon}
                            tone={tone}
                            titleId={titleId}
                            descriptionId={descriptionId}
                            actions={headerActions}
                            onClose={showCloseButton ? closeFromButton : undefined}
                            className={headerClassName}
                          />
                        ) : null
                      )}

                      <DrawerBody unpadded={unpaddedBody} className={bodyClassName}>
                        {children}
                      </DrawerBody>

                      {footer ? (
                        <DrawerFooter className={footerClassName}>{footer}</DrawerFooter>
                      ) : null}
                    </DrawerDepthContext.Provider>
                  </OverlayCloseContext.Provider>
                </motion.div>
              </div>
            </FloatingFocusManager>
          </FloatingOverlay>
        </FloatingPortal>
      ) : null}
    </AnimatePresence>
  );
}

export type DrawerHeaderProps = DialogHeaderProps;

export function DrawerHeader(props: DrawerHeaderProps) {
  return <DialogHeader {...props} className={cx("px-4 py-3.5", props.className)} />;
}

export type DrawerBodyProps = DialogBodyProps;

export function DrawerBody({ children, className, unpadded = false }: DrawerBodyProps) {
  return (
    <div
      className={cx(
        "min-h-0 flex-1 overflow-y-auto overscroll-contain",
        unpadded ? "" : "px-4 py-4",
        className,
      )}
    >
      {children}
    </div>
  );
}

export type DrawerFooterProps = DialogFooterProps;

export function DrawerFooter({ children, className, align = "end" }: DrawerFooterProps) {
  return (
    <DialogFooter align={align} className={cx("px-4 py-3", className)}>
      {children}
    </DialogFooter>
  );
}

/** Bottom sheet. Same component, mobile-first defaults. */
export type SheetProps = Omit<DrawerProps, "side"> & { side?: DrawerSide };

export function Sheet({ side = "bottom", size = "lg", ...rest }: SheetProps) {
  return <Drawer side={side} size={size} {...rest} />;
}

/* ==========================================================================
   Anchored surfaces: Popover · Tooltip · HoverCard
   --------------------------------------------------------------------------
   All three clone their trigger element and attach the reference ref to it, so
   there is no extra wrapper element in the DOM to break your flex layout. The
   trigger must forward its ref — every control in this design system does.
========================================================================== */

/** Merge our reference ref with whatever ref the caller already put on the trigger. */
function useTriggerRef(
  trigger: ReactElement | undefined,
  setReference: (node: HTMLElement | null) => void,
): Ref<HTMLElement> {
  const external =
    trigger && isValidElement(trigger)
      ? (trigger.props as { ref?: Ref<HTMLElement> }).ref
      : undefined;
  return useMergeRefs<HTMLElement>([setReference, external]);
}

function cloneTrigger(
  trigger: ReactElement | undefined,
  getReferenceProps: (userProps?: HTMLProps<Element>) => Record<string, unknown>,
  ref: Ref<HTMLElement>,
): ReactNode {
  if (!trigger || !isValidElement(trigger)) return null;
  return cloneElement(
    trigger as ReactElement<Record<string, unknown>>,
    getReferenceProps({ ref, ...(trigger.props as HTMLProps<Element>) }) as Record<
      string,
      unknown
    >,
  );
}

/* ------------------------------------------------------------------ Popover */

export interface PopoverProps {
  /** The element that opens the popover. Cloned, so it must forward a ref. */
  trigger?: ReactElement;
  /** Anchor to an existing element instead of cloning a trigger. */
  anchorRef?: RefObject<HTMLElement | null>;

  children?: ReactNode;
  /** Alternative to `children`, for call sites that prefer a prop. */
  content?: ReactNode;

  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;

  placement?: Placement;
  sideOffset?: number;
  showArrow?: boolean;
  /** Trap focus and block outside interaction. Default `false`. */
  modal?: boolean;
  matchTriggerWidth?: boolean;
  width?: number | string;
  maxHeight?: number | string;

  title?: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
  /** Set `false` for edge-to-edge content such as a list. Default `true`. */
  padded?: boolean;

  closeOnOutsideClick?: boolean;
  closeOnEscape?: boolean;
  disabled?: boolean;

  className?: string;
  initialFocus?: number | RefObject<HTMLElement | null>;
  returnFocus?: boolean;
  role?: "dialog" | "menu" | "listbox" | "tree" | "grid";
  "aria-label"?: string;
  portalId?: string;
  zIndexClass?: string;
}

export function Popover({
  trigger,
  anchorRef,
  children,
  content,
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  placement = "bottom-start",
  sideOffset = 6,
  showArrow = false,
  modal = false,
  matchTriggerWidth = false,
  width,
  maxHeight,
  title,
  description,
  footer,
  padded = true,
  closeOnOutsideClick = true,
  closeOnEscape = true,
  disabled = false,
  className,
  initialFocus,
  returnFocus = true,
  role = "dialog",
  "aria-label": ariaLabel,
  portalId = OVERLAY_PORTAL_ID,
  zIndexClass = Z_CLASS.popover,
}: PopoverProps) {
  const [open, setOpen] = useControllableState(controlledOpen, defaultOpen, onOpenChange);
  const arrowRef = useRef<SVGSVGElement>(null);
  const generatedId = useId();
  const titleId = `${generatedId}-title`;
  const descriptionId = `${generatedId}-description`;

  const { refs, floatingStyles, context, placement: resolvedPlacement } = useFloating({
    open: open && !disabled,
    onOpenChange: setOpen,
    placement,
    middleware: [
      offset(sideOffset + (showArrow ? 5 : 0)),
      flip({ padding: 10 }),
      shift({ padding: 10 }),
      floatingSize({
        padding: 10,
        apply({ availableHeight, rects, elements }) {
          elements.floating.style.setProperty(
            "--ds-avail-h",
            `${Math.max(140, Math.floor(availableHeight))}px`,
          );
          if (matchTriggerWidth) {
            elements.floating.style.width = `${rects.reference.width}px`;
          }
        },
      }),
      showArrow ? arrow({ element: arrowRef }) : null,
    ],
    whileElementsMounted: autoUpdate,
  });

  useEffect(() => {
    if (anchorRef?.current) refs.setPositionReference(anchorRef.current);
  }, [anchorRef, refs, open]);

  const click = useClick(context, { enabled: !disabled && trigger !== undefined });
  const dismiss = useDismiss(context, {
    escapeKey: false,
    outsidePress: closeOnOutsideClick,
  });
  const floatingRole = useRole(context, { role });
  const { getReferenceProps, getFloatingProps } = useInteractions([click, dismiss, floatingRole]);

  useOverlayEscape(open && !disabled, () => setOpen(false), closeOnEscape);

  const triggerRef = useTriggerRef(trigger, refs.setReference);
  const close = useCallback(() => setOpen(false), [setOpen]);
  const panelVariants = useVariants(scaleIn);
  const body = content ?? children;

  return (
    <>
      {cloneTrigger(trigger, getReferenceProps, triggerRef)}
      <AnimatePresence>
        {open && !disabled ? (
          <FloatingPortal key="popover" id={portalId}>
            <FloatingFocusManager
              context={context}
              modal={modal}
              initialFocus={initialFocus}
              returnFocus={returnFocus}
            >
              <div
                ref={refs.setFloating}
                style={{ ...floatingStyles, width }}
                {...getFloatingProps()}
                {...(title === undefined ? {} : { "aria-labelledby": titleId })}
                {...(description === undefined ? {} : { "aria-describedby": descriptionId })}
                {...(ariaLabel === undefined ? {} : { "aria-label": ariaLabel })}
                className={cx(zIndexClass, "outline-none")}
              >
                <motion.div
                  variants={panelVariants}
                  initial="hidden"
                  animate="visible"
                  exit="exit"
                  style={{
                    transformOrigin: transformOrigin(resolvedPlacement),
                    maxHeight: maxHeight ?? "var(--ds-avail-h, none)",
                  }}
                  className={cx(
                    FLOATING_PANEL,
                    "flex min-w-[12rem] flex-col overflow-hidden",
                    className,
                  )}
                >
                  <OverlayCloseContext.Provider value={close}>
                    {title !== undefined || description !== undefined ? (
                      <div
                        className={cx(
                          "shrink-0 border-b border-border-subtle px-3.5 pt-3 pb-2.5",
                        )}
                      >
                        {title !== undefined ? (
                          <p id={titleId} className="text-body font-semibold text-content">
                            {title}
                          </p>
                        ) : null}
                        {description !== undefined ? (
                          <p id={descriptionId} className="mt-0.5 text-meta text-content-muted">
                            {description}
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                    <div
                      className={cx(
                        "min-h-0 flex-1 overflow-y-auto overscroll-contain",
                        padded ? "p-3.5" : "",
                      )}
                    >
                      {body}
                    </div>
                    {footer ? (
                      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border-subtle bg-surface-sunken/50 px-3.5 py-2.5">
                        {footer}
                      </div>
                    ) : null}
                  </OverlayCloseContext.Provider>
                  {showArrow ? (
                    <FloatingArrow
                      ref={arrowRef}
                      context={context}
                      width={12}
                      height={6}
                      tipRadius={1.5}
                      className="fill-surface-overlay [&>path:first-of-type]:stroke-border"
                      strokeWidth={1}
                    />
                  ) : null}
                </motion.div>
              </div>
            </FloatingFocusManager>
          </FloatingPortal>
        ) : null}
      </AnimatePresence>
    </>
  );
}

/* ------------------------------------------------------------------ Tooltip */

export interface TooltipProps {
  /** Single element. Cloned, so it must forward a ref. */
  children: ReactElement;
  content: ReactNode;
  /** Rendered as keycaps on the right, e.g. "⌘+K" or "Shift+Enter". */
  shortcut?: string;
  placement?: Placement;
  /** ms before showing / hiding. Default `{ open: 350, close: 80 }`. */
  delay?: number | { open?: number; close?: number };
  disabled?: boolean;
  showArrow?: boolean;
  sideOffset?: number;
  maxWidth?: number;
  /** Allows the pointer to travel into the tooltip (for links inside). */
  interactive?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  portalId?: string;
}

export function Tooltip({
  children,
  content,
  shortcut,
  placement = "top",
  delay = { open: 350, close: 80 },
  disabled = false,
  showArrow = true,
  sideOffset = 6,
  maxWidth = 280,
  interactive = false,
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  className,
  portalId = OVERLAY_PORTAL_ID,
}: TooltipProps) {
  const [open, setOpen] = useControllableState(controlledOpen, defaultOpen, onOpenChange);
  const arrowRef = useRef<SVGSVGElement>(null);
  const isEmpty = content === null || content === undefined || content === "";
  const active = open && !disabled && !isEmpty;

  const { refs, floatingStyles, context, placement: resolvedPlacement } = useFloating({
    open: active,
    onOpenChange: setOpen,
    placement,
    middleware: [
      offset(sideOffset + (showArrow ? 4 : 0)),
      flip({ padding: 8 }),
      shift({ padding: 8 }),
      showArrow ? arrow({ element: arrowRef }) : null,
    ],
    whileElementsMounted: autoUpdate,
  });

  const hover = useHover(context, {
    enabled: !disabled && !isEmpty,
    move: false,
    delay,
    handleClose: interactive ? safePolygon({ blockPointerEvents: false }) : null,
  });
  const focus = useFocus(context, { enabled: !disabled && !isEmpty });
  const dismiss = useDismiss(context, { escapeKey: false, referencePress: true });
  const role = useRole(context, { role: "tooltip" });
  const { getReferenceProps, getFloatingProps } = useInteractions([hover, focus, dismiss, role]);

  useOverlayEscape(active, () => setOpen(false));

  const triggerRef = useTriggerRef(children, refs.setReference);
  const panelVariants = useVariants(scaleIn);

  return (
    <>
      {cloneTrigger(children, getReferenceProps, triggerRef)}
      <AnimatePresence>
        {active ? (
          <FloatingPortal key="tooltip" id={portalId}>
            <div
              ref={refs.setFloating}
              style={floatingStyles}
              {...getFloatingProps()}
              className={cx(Z_CLASS.tooltip, interactive ? "" : "pointer-events-none")}
            >
              <motion.div
                variants={panelVariants}
                initial="hidden"
                animate="visible"
                exit="exit"
                style={{
                  transformOrigin: transformOrigin(resolvedPlacement),
                  maxWidth,
                }}
                className={cx(
                  "flex items-center gap-1.5 rounded-md px-2 py-1",
                  "bg-surface-inverse text-meta font-medium text-surface-inverse-fg shadow-e2",
                  className,
                )}
              >
                <span className="min-w-0">{content}</span>
                {shortcut ? (
                  <span className="flex shrink-0 items-center gap-0.5">
                    {shortcut
                      .split(/(?<!^)\+/g)
                      .filter(Boolean)
                      .map((part, index) => (
                        <kbd
                          key={`${part}-${index}`}
                          className={cx(
                            "grid h-[1.0625rem] min-w-[1.0625rem] place-items-center rounded-xs px-1",
                            "border border-border-inverse bg-surface-inverse-fg/10",
                            "font-sans text-2xs font-medium text-surface-inverse-fg/85",
                          )}
                        >
                          {part}
                        </kbd>
                      ))}
                  </span>
                ) : null}
                {showArrow ? (
                  <FloatingArrow
                    ref={arrowRef}
                    context={context}
                    width={11}
                    height={5}
                    tipRadius={1}
                    className="fill-surface-inverse"
                  />
                ) : null}
              </motion.div>
            </div>
          </FloatingPortal>
        ) : null}
      </AnimatePresence>
    </>
  );
}

/**
 * Share one open delay across a cluster of tooltips — hover the first, the rest
 * appear instantly. Wrap a toolbar or an icon-button row in it.
 */
export interface TooltipGroupProps {
  children: ReactNode;
  delay?: number | { open?: number; close?: number };
  /** Grace period after leaving the group before the delay resets. */
  timeoutMs?: number;
}

export function TooltipGroup({
  children,
  delay = { open: 350, close: 80 },
  timeoutMs = 300,
}: TooltipGroupProps) {
  return (
    <FloatingDelayGroup delay={delay} timeoutMs={timeoutMs}>
      {children}
    </FloatingDelayGroup>
  );
}

/* ---------------------------------------------------------------- HoverCard */

export interface HoverCardProps {
  children: ReactElement;
  content?: ReactNode;
  /** Alternative to `content`. */
  card?: ReactNode;
  placement?: Placement;
  openDelay?: number;
  closeDelay?: number;
  showArrow?: boolean;
  sideOffset?: number;
  width?: number | string;
  disabled?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  padded?: boolean;
  portalId?: string;
}

/**
 * The lazy-preview surface: hover a record reference and get its summary.
 * Non-modal, pointer-forgiving (safePolygon), and keyboard-reachable via focus.
 */
export function HoverCard({
  children,
  content,
  card,
  placement = "bottom-start",
  openDelay = 320,
  closeDelay = 140,
  showArrow = false,
  sideOffset = 8,
  width = 320,
  disabled = false,
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  className,
  padded = true,
  portalId = OVERLAY_PORTAL_ID,
}: HoverCardProps) {
  const [open, setOpen] = useControllableState(controlledOpen, defaultOpen, onOpenChange);
  const arrowRef = useRef<SVGSVGElement>(null);
  const active = open && !disabled;

  const { refs, floatingStyles, context, placement: resolvedPlacement } = useFloating({
    open: active,
    onOpenChange: setOpen,
    placement,
    middleware: [
      offset(sideOffset + (showArrow ? 5 : 0)),
      flip({ padding: 10 }),
      shift({ padding: 10 }),
      showArrow ? arrow({ element: arrowRef }) : null,
    ],
    whileElementsMounted: autoUpdate,
  });

  const hover = useHover(context, {
    enabled: !disabled,
    move: false,
    delay: { open: openDelay, close: closeDelay },
    handleClose: safePolygon({ blockPointerEvents: false }),
  });
  const focus = useFocus(context, { enabled: !disabled });
  const dismiss = useDismiss(context, { escapeKey: false });
  const role = useRole(context, { role: "dialog" });
  const { getReferenceProps, getFloatingProps } = useInteractions([hover, focus, dismiss, role]);

  useOverlayEscape(active, () => setOpen(false));

  const triggerRef = useTriggerRef(children, refs.setReference);
  const panelVariants = useVariants(scaleIn);
  const body = card ?? content;

  return (
    <>
      {cloneTrigger(children, getReferenceProps, triggerRef)}
      <AnimatePresence>
        {active ? (
          <FloatingPortal key="hovercard" id={portalId}>
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
                style={{ transformOrigin: transformOrigin(resolvedPlacement) }}
                className={cx(FLOATING_PANEL, padded ? "p-3.5" : "", className)}
              >
                <OverlayCloseContext.Provider value={() => setOpen(false)}>
                  {body}
                </OverlayCloseContext.Provider>
                {showArrow ? (
                  <FloatingArrow
                    ref={arrowRef}
                    context={context}
                    width={12}
                    height={6}
                    tipRadius={1.5}
                    className="fill-surface-overlay [&>path:first-of-type]:stroke-border"
                    strokeWidth={1}
                  />
                ) : null}
              </motion.div>
            </div>
          </FloatingPortal>
        ) : null}
      </AnimatePresence>
    </>
  );
}

/* ==========================================================================
   Menus: DropdownMenu · MenuSub · ContextMenu
   --------------------------------------------------------------------------
   One item vocabulary serves all three surfaces. Items are real <button>s in a
   roving-tabindex list, so arrow keys, Home/End, typeahead, ArrowRight into a
   submenu and ArrowLeft back out all work without extra wiring.

   Two authoring styles, same result:

     <DropdownMenu trigger={<IconButton …/>} items={[
       { label: "Rename", icon: IconEdit, onSelect: rename },
       { type: "separator" },
       { label: "Delete", icon: IconTrash, destructive: true, onSelect: remove },
     ]} />

     <DropdownMenu trigger={…}>
       <MenuItem icon={IconEdit} onSelect={rename}>Rename</MenuItem>
       <MenuSeparator />
       <MenuItem icon={IconTrash} destructive onSelect={remove}>Delete</MenuItem>
     </DropdownMenu>
========================================================================== */

interface MenuContextValue {
  getItemProps: (
    userProps?: Omit<HTMLProps<HTMLElement>, "selected" | "active">,
  ) => Record<string, unknown>;
  activeIndex: number | null;
  setActiveIndex: (index: number | null) => void;
  setHasFocusInside: (value: boolean) => void;
  isOpen: boolean;
  /** Collapses the whole menu tree, from any depth. */
  closeAll: () => void;
}

const MenuContext = createContext<MenuContextValue>({
  getItemProps: () => ({}),
  activeIndex: null,
  setActiveIndex: noop,
  setHasFocusInside: noop,
  isOpen: false,
  closeAll: noop,
});

const MenuRadioContext = createContext<{
  value: string | undefined;
  onValueChange: (value: string) => void;
} | null>(null);

/** Best-effort plain text of a node, for typeahead labels. */
function textOf(node: ReactNode): string | null {
  if (node === null || node === undefined || typeof node === "boolean") return null;
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) {
    const parts = (node as ReactNode[])
      .map((child) => textOf(child))
      .filter((value): value is string => value !== null);
    return parts.length > 0 ? parts.join(" ") : null;
  }
  if (isValidElement(node)) {
    return textOf((node.props as { children?: ReactNode }).children);
  }
  return null;
}

const MENU_PANEL =
  "flex max-h-[min(28rem,var(--ds-avail-h,28rem))] min-w-[11.5rem] flex-col " +
  "overflow-y-auto overscroll-contain p-1 outline-none";

const MENU_ROW =
  "relative flex w-full cursor-default select-none items-center gap-2.5 rounded-md " +
  "px-2 py-1.5 text-left text-body outline-none transition-colors duration-instant";

const MENU_ROW_ENABLED =
  "text-content data-[active=true]:bg-surface-hover data-[active=true]:text-content " +
  "data-[open=true]:bg-surface-hover";

const MENU_ROW_DESTRUCTIVE =
  "text-danger-fg data-[active=true]:bg-danger-subtle data-[active=true]:text-danger-fg";

const MENU_ROW_DISABLED = "pointer-events-none text-content-disabled";

/* --------------------------------------------------------------- MenuItem */

export interface MenuItemProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type" | "onSelect"> {
  children?: ReactNode;
  /** Alternative to `children`. */
  label?: ReactNode;
  icon?: IconLike;
  /** Rendered hard right, after any shortcut. */
  trailingIcon?: IconLike;
  /** e.g. "⌘+K", "Shift+Enter". Rendered as keycaps. */
  shortcut?: string;
  /** Secondary line under the label. */
  description?: ReactNode;
  destructive?: boolean;
  /** Draws a check on the left rail without changing the role. */
  selected?: boolean;
  onSelect?: () => void;
  /** Default `true`. Set `false` for rows that toggle in place. */
  closeOnSelect?: boolean;
}

export const MenuItem = forwardRef<HTMLButtonElement, MenuItemProps>(function MenuItem(
  {
    children,
    label,
    icon,
    trailingIcon,
    shortcut,
    description,
    destructive = false,
    selected = false,
    disabled = false,
    onSelect,
    closeOnSelect = true,
    className,
    onClick,
    onFocus,
    ...rest
  },
  forwardedRef,
) {
  const menu = useContext(MenuContext);
  const tree = useFloatingTree();
  const content = children ?? label;
  const item = useListItem({ label: disabled ? null : textOf(content) });
  const ref = useMergeRefs<HTMLButtonElement>([item.ref, forwardedRef]);
  const isActive = menu.activeIndex === item.index;

  return (
    <button
      ref={ref}
      type="button"
      role="menuitem"
      disabled={disabled}
      tabIndex={isActive ? 0 : -1}
      data-active={isActive ? "true" : "false"}
      className={cx(
        MENU_ROW,
        disabled ? MENU_ROW_DISABLED : destructive ? MENU_ROW_DESTRUCTIVE : MENU_ROW_ENABLED,
        className,
      )}
      {...menu.getItemProps({
        ...rest,
        onClick(event) {
          onClick?.(event as ReactMouseEvent<HTMLButtonElement>);
          if (disabled) return;
          onSelect?.();
          if (closeOnSelect) tree?.events.emit("click");
        },
        onFocus(event) {
          onFocus?.(event as ReactFocusEvent<HTMLButtonElement>);
          menu.setHasFocusInside(true);
        },
      })}
    >
      {selected ? (
        <IconCheck size={15} className="-ml-0.5 shrink-0 text-accent-text" />
      ) : icon ? (
        <span className="shrink-0 text-content-subtle">{renderIcon(icon, 15)}</span>
      ) : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{content}</span>
        {description ? (
          <span className="mt-0.5 block truncate text-meta text-content-subtle">
            {description}
          </span>
        ) : null}
      </span>
      {shortcut ? <ShortcutKeys keys={shortcut} /> : null}
      {trailingIcon ? (
        <span className="shrink-0 text-content-subtle">{renderIcon(trailingIcon, 14)}</span>
      ) : null}
    </button>
  );
});

/* -------------------------------------------------------- structural parts */

export function MenuSeparator({ className }: { className?: string }) {
  return <div role="separator" className={cx("-mx-1 my-1 h-px bg-border-subtle", className)} />;
}

export function MenuLabel({
  children,
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "px-2 pt-2 pb-1 text-label uppercase text-content-subtle select-none",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function MenuGroup({
  label,
  children,
  className,
}: {
  label?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div role="group" className={cx("contents", className)}>
      {label !== undefined ? <MenuLabel>{label}</MenuLabel> : null}
      {children}
    </div>
  );
}

/* ------------------------------------------------------ checkbox and radio */

export interface MenuCheckboxItemProps extends Omit<MenuItemProps, "selected" | "onSelect"> {
  checked: boolean;
  onCheckedChange?: (checked: boolean) => void;
}

export const MenuCheckboxItem = forwardRef<HTMLButtonElement, MenuCheckboxItemProps>(
  function MenuCheckboxItem(
    { checked, onCheckedChange, children, label, icon, closeOnSelect = false, className, ...rest },
    forwardedRef,
  ) {
    return (
      <MenuItem
        ref={forwardedRef}
        role="menuitemcheckbox"
        aria-checked={checked}
        closeOnSelect={closeOnSelect}
        onSelect={() => onCheckedChange?.(!checked)}
        className={className}
        {...rest}
      >
        <span className="flex items-center gap-2.5">
          <span
            aria-hidden
            className={cx(
              "grid size-4 shrink-0 place-items-center rounded-xs border transition-colors duration-fast",
              checked
                ? "border-accent bg-accent text-accent-fg"
                : "border-border-strong bg-surface-raised",
            )}
          >
            {checked ? <IconCheck size={11} strokeWidth={2.75} /> : null}
          </span>
          {icon ? <span className="shrink-0 text-content-subtle">{renderIcon(icon, 15)}</span> : null}
          <span className="min-w-0 truncate">{children ?? label}</span>
        </span>
      </MenuItem>
    );
  },
);

export interface MenuRadioGroupProps {
  value?: string;
  onValueChange?: (value: string) => void;
  label?: ReactNode;
  children?: ReactNode;
}

export function MenuRadioGroup({ value, onValueChange, label, children }: MenuRadioGroupProps) {
  const context = useMemo(
    () => ({ value, onValueChange: (next: string) => onValueChange?.(next) }),
    [value, onValueChange],
  );
  return (
    <MenuRadioContext.Provider value={context}>
      <div role="group" className="contents">
        {label !== undefined ? <MenuLabel>{label}</MenuLabel> : null}
        {children}
      </div>
    </MenuRadioContext.Provider>
  );
}

export interface MenuRadioItemProps extends Omit<MenuItemProps, "selected" | "onSelect"> {
  value: string;
}

export const MenuRadioItem = forwardRef<HTMLButtonElement, MenuRadioItemProps>(
  function MenuRadioItem({ value, children, label, className, ...rest }, forwardedRef) {
    const group = useContext(MenuRadioContext);
    const checked = group?.value === value;
    return (
      <MenuItem
        ref={forwardedRef}
        role="menuitemradio"
        aria-checked={checked}
        onSelect={() => group?.onValueChange(value)}
        className={className}
        {...rest}
      >
        <span className="flex items-center gap-2.5">
          <span
            aria-hidden
            className={cx(
              "grid size-4 shrink-0 place-items-center rounded-full border transition-colors duration-fast",
              checked ? "border-accent" : "border-border-strong",
            )}
          >
            {checked ? <span className="size-2 rounded-full bg-accent" /> : null}
          </span>
          <span className="min-w-0 truncate">{children ?? label}</span>
        </span>
      </MenuItem>
    );
  },
);

/* -------------------------------------------------- data-driven item specs */

interface MenuItemSpecBase {
  id?: string;
  disabled?: boolean;
}

export type MenuItemSpec =
  | (MenuItemSpecBase & {
      type?: "item";
      label: ReactNode;
      icon?: IconLike;
      shortcut?: string;
      description?: ReactNode;
      destructive?: boolean;
      selected?: boolean;
      closeOnSelect?: boolean;
      onSelect?: () => void;
    })
  | (MenuItemSpecBase & { type: "separator" })
  | (MenuItemSpecBase & { type: "label"; label: ReactNode })
  | (MenuItemSpecBase & {
      type: "checkbox";
      label: ReactNode;
      icon?: IconLike;
      shortcut?: string;
      checked: boolean;
      onCheckedChange?: (checked: boolean) => void;
    })
  | (MenuItemSpecBase & {
      type: "radio-group";
      label?: ReactNode;
      value?: string;
      onValueChange?: (value: string) => void;
      options: Array<{ value: string; label: ReactNode; icon?: IconLike; disabled?: boolean }>;
    })
  | (MenuItemSpecBase & {
      type: "submenu";
      label: ReactNode;
      icon?: IconLike;
      items: MenuItemSpec[];
    });

function renderMenuSpecs(specs: MenuItemSpec[]): ReactNode {
  return specs.map((spec, index) => {
    const key = spec.id ?? `menu-${index}`;
    switch (spec.type) {
      case "separator":
        return <MenuSeparator key={key} />;
      case "label":
        return <MenuLabel key={key}>{spec.label}</MenuLabel>;
      case "checkbox":
        return (
          <MenuCheckboxItem
            key={key}
            checked={spec.checked}
            onCheckedChange={spec.onCheckedChange}
            icon={spec.icon}
            shortcut={spec.shortcut}
            disabled={spec.disabled}
          >
            {spec.label}
          </MenuCheckboxItem>
        );
      case "radio-group":
        return (
          <MenuRadioGroup
            key={key}
            label={spec.label}
            value={spec.value}
            onValueChange={spec.onValueChange}
          >
            {spec.options.map((option) => (
              <MenuRadioItem
                key={option.value}
                value={option.value}
                icon={option.icon}
                disabled={option.disabled}
              >
                {option.label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        );
      case "submenu":
        return (
          <MenuSub key={key} label={spec.label} icon={spec.icon} disabled={spec.disabled}>
            {renderMenuSpecs(spec.items)}
          </MenuSub>
        );
      default:
        return (
          <MenuItem
            key={key}
            icon={spec.icon}
            shortcut={spec.shortcut}
            description={spec.description}
            destructive={spec.destructive}
            selected={spec.selected}
            disabled={spec.disabled}
            closeOnSelect={spec.closeOnSelect}
            onSelect={spec.onSelect}
          >
            {spec.label}
          </MenuItem>
        );
    }
  });
}

/* ----------------------------------------------------------- the menu core */

export interface DropdownMenuProps {
  /** Root menus only. Cloned, so it must forward a ref. */
  trigger?: ReactElement;
  /** Submenus only: the row label rendered in the parent menu. */
  label?: ReactNode;
  icon?: IconLike;

  items?: MenuItemSpec[];
  children?: ReactNode;

  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;

  placement?: Placement;
  sideOffset?: number;
  disabled?: boolean;
  matchTriggerWidth?: boolean;
  width?: number | string;
  header?: ReactNode;
  footer?: ReactNode;
  className?: string;
  "aria-label"?: string;
  portalId?: string;
  zIndexClass?: string;
}

const MenuCore = forwardRef<HTMLButtonElement, DropdownMenuProps>(function MenuCore(
  {
    trigger,
    label,
    icon,
    items,
    children,
    open: controlledOpen,
    defaultOpen = false,
    onOpenChange,
    placement,
    sideOffset = 5,
    disabled = false,
    matchTriggerWidth = false,
    width,
    header,
    footer,
    className,
    "aria-label": ariaLabel,
    portalId = OVERLAY_PORTAL_ID,
    zIndexClass = Z_CLASS.popover,
  },
  forwardedRef,
) {
  const [isOpen, setIsOpen] = useControllableState(controlledOpen, defaultOpen, onOpenChange);
  const [hasFocusInside, setHasFocusInside] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const elementsRef = useRef<Array<HTMLButtonElement | null>>([]);
  const labelsRef = useRef<Array<string | null>>([]);

  const parent = useContext(MenuContext);
  const tree = useFloatingTree();
  const nodeId = useFloatingNodeId();
  const parentId = useFloatingParentNodeId();
  const item = useListItem({ label: textOf(label) });
  const isNested = parentId !== null;

  const { refs, floatingStyles, context, placement: resolvedPlacement } = useFloating<HTMLButtonElement>({
    nodeId,
    open: isOpen && !disabled,
    onOpenChange: setIsOpen,
    placement: placement ?? (isNested ? "right-start" : "bottom-start"),
    middleware: [
      offset(isNested ? { mainAxis: 2, alignmentAxis: -5 } : { mainAxis: sideOffset }),
      flip({ padding: 10 }),
      shift({ padding: 10 }),
      floatingSize({
        padding: 10,
        apply({ availableHeight, rects, elements }) {
          elements.floating.style.setProperty(
            "--ds-avail-h",
            `${Math.max(160, Math.floor(availableHeight))}px`,
          );
          if (matchTriggerWidth) {
            elements.floating.style.minWidth = `${rects.reference.width}px`;
          }
        },
      }),
    ],
    whileElementsMounted: autoUpdate,
  });

  const hover = useHover(context, {
    enabled: isNested && !disabled,
    delay: { open: 60 },
    handleClose: safePolygon({ blockPointerEvents: true }),
  });
  const click = useClick(context, {
    enabled: !disabled,
    event: "mousedown",
    toggle: !isNested,
    ignoreMouse: isNested,
  });
  const role = useRole(context, { role: "menu" });
  const dismiss = useDismiss(context, { escapeKey: false, bubbles: true });
  const listNavigation = useListNavigation(context, {
    listRef: elementsRef,
    activeIndex,
    nested: isNested,
    onNavigate: setActiveIndex,
  });
  const typeahead = useTypeahead(context, {
    listRef: labelsRef,
    onMatch: isOpen ? setActiveIndex : undefined,
    activeIndex,
  });

  const { getReferenceProps, getFloatingProps, getItemProps } = useInteractions([
    hover,
    click,
    role,
    dismiss,
    listNavigation,
    typeahead,
  ]);

  /* Selecting anywhere in the tree closes the whole tree. */
  useEffect(() => {
    if (!tree) return;
    function onTreeClick(): void {
      setIsOpen(false);
    }
    function onSubMenuOpen(event: { nodeId: string; parentId: string }): void {
      if (event.nodeId !== nodeId && event.parentId === parentId) setIsOpen(false);
    }
    tree.events.on("click", onTreeClick);
    tree.events.on("menuopen", onSubMenuOpen);
    return () => {
      tree.events.off("click", onTreeClick);
      tree.events.off("menuopen", onSubMenuOpen);
    };
  }, [tree, nodeId, parentId, setIsOpen]);

  useEffect(() => {
    if (isOpen && tree) tree.events.emit("menuopen", { parentId, nodeId });
  }, [tree, isOpen, nodeId, parentId]);

  /* Escape closes this level only, and hands focus back to the parent row. */
  useOverlayEscape(isOpen && !disabled, () => {
    setIsOpen(false);
    if (isNested) refs.domReference.current?.focus();
  });

  const closeAll = useCallback(() => {
    tree?.events.emit("click");
    setIsOpen(false);
  }, [tree, setIsOpen]);

  const menuContext = useMemo<MenuContextValue>(
    () => ({
      getItemProps,
      activeIndex,
      setActiveIndex,
      setHasFocusInside,
      isOpen,
      closeAll,
    }),
    [getItemProps, activeIndex, isOpen, closeAll],
  );

  const triggerRef = useMergeRefs<HTMLButtonElement>([
    refs.setReference,
    item.ref,
    forwardedRef,
    trigger && isValidElement(trigger)
      ? ((trigger.props as { ref?: Ref<HTMLButtonElement> }).ref ?? null)
      : null,
  ]);

  const panelVariants = useVariants(scaleIn);
  const body = items ? renderMenuSpecs(items) : children;

  const referenceNode = isNested ? (
    <button
      ref={triggerRef}
      type="button"
      role="menuitem"
      disabled={disabled}
      data-open={isOpen ? "true" : "false"}
      data-active={parent.activeIndex === item.index ? "true" : "false"}
      data-nested=""
      tabIndex={parent.activeIndex === item.index ? 0 : -1}
      className={cx(MENU_ROW, disabled ? MENU_ROW_DISABLED : MENU_ROW_ENABLED)}
      {...getReferenceProps(
        parent.getItemProps({
          onFocus() {
            setHasFocusInside(false);
            parent.setHasFocusInside(true);
          },
        }),
      )}
    >
      {icon ? <span className="shrink-0 text-content-subtle">{renderIcon(icon, 15)}</span> : null}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <IconChevronRight size={14} className="ml-auto shrink-0 text-content-subtle" />
    </button>
  ) : (
    cloneTrigger(
      trigger,
      (userProps) => getReferenceProps(userProps),
      triggerRef as Ref<HTMLElement>,
    )
  );

  return (
    <FloatingNode id={nodeId}>
      {referenceNode}
      <MenuContext.Provider value={menuContext}>
        <FloatingList elementsRef={elementsRef} labelsRef={labelsRef}>
          <AnimatePresence>
            {isOpen && !disabled ? (
              <FloatingPortal key="menu" id={portalId}>
                <FloatingFocusManager
                  context={context}
                  modal={false}
                  initialFocus={isNested ? -1 : 0}
                  returnFocus={!isNested}
                >
                  <div
                    ref={refs.setFloating}
                    style={{ ...floatingStyles, width }}
                    {...getFloatingProps()}
                    aria-label={ariaLabel ?? (typeof label === "string" ? label : undefined)}
                    className={cx(zIndexClass, "outline-none")}
                  >
                    <motion.div
                      variants={panelVariants}
                      initial="hidden"
                      animate="visible"
                      exit="exit"
                      style={{ transformOrigin: transformOrigin(resolvedPlacement) }}
                      className={cx(FLOATING_PANEL, MENU_PANEL, className)}
                    >
                      <OverlayCloseContext.Provider value={closeAll}>
                        {header ? (
                          <div className="-mx-1 -mt-1 mb-1 border-b border-border-subtle px-3 py-2">
                            {header}
                          </div>
                        ) : null}
                        {body}
                        {footer ? (
                          <div className="-mx-1 -mb-1 mt-1 border-t border-border-subtle px-3 py-2">
                            {footer}
                          </div>
                        ) : null}
                      </OverlayCloseContext.Provider>
                    </motion.div>
                  </div>
                </FloatingFocusManager>
              </FloatingPortal>
            ) : null}
          </AnimatePresence>
        </FloatingList>
      </MenuContext.Provider>
    </FloatingNode>
  );
});

/**
 * Root dropdown. Renders the FloatingTree that submenus coordinate through, so
 * `<MenuSub>` works at any depth without extra setup.
 */
export const DropdownMenu = forwardRef<HTMLButtonElement, DropdownMenuProps>(
  function DropdownMenu(props, ref) {
    const parentId = useFloatingParentNodeId();
    if (parentId === null) {
      return (
        <FloatingTree>
          <MenuCore {...props} ref={ref} />
        </FloatingTree>
      );
    }
    return <MenuCore {...props} ref={ref} />;
  },
);

/** A nested menu. Identical to DropdownMenu; named for readability. */
export const MenuSub = forwardRef<HTMLButtonElement, DropdownMenuProps>(
  function MenuSub(props, ref) {
    return <MenuCore {...props} ref={ref} />;
  },
);

/* ------------------------------------------------------------ ContextMenu */

export interface ContextMenuProps {
  /** The region that responds to right-click / the Menu key. */
  children: ReactNode;
  items?: MenuItemSpec[];
  /** Menu body, when not using `items`. */
  content?: ReactNode;
  disabled?: boolean;
  onOpenChange?: (open: boolean) => void;
  width?: number | string;
  /** Wrapper class. Defaults to `contents` so no box is introduced. */
  className?: string;
  menuClassName?: string;
  "aria-label"?: string;
  portalId?: string;
}

function ContextMenuInner({
  children,
  items,
  content,
  disabled = false,
  onOpenChange,
  width,
  className = "contents",
  menuClassName,
  "aria-label": ariaLabel,
  portalId = OVERLAY_PORTAL_ID,
}: ContextMenuProps) {
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const elementsRef = useRef<Array<HTMLButtonElement | null>>([]);
  const labelsRef = useRef<Array<string | null>>([]);
  const nodeId = useFloatingNodeId();
  const emitOpenChange = useEvent(onOpenChange);

  const isOpen = point !== null && !disabled;

  const setOpen = useCallback(
    (next: boolean) => {
      if (!next) setPoint(null);
      emitOpenChange(next);
    },
    [emitOpenChange],
  );

  const { refs, floatingStyles, context, placement: resolvedPlacement } = useFloating({
    nodeId,
    open: isOpen,
    onOpenChange: setOpen,
    placement: "right-start",
    middleware: [
      offset({ mainAxis: 4, crossAxis: 4 }),
      flip({ fallbackPlacements: ["left-start", "right-end", "left-end"] }),
      shift({ padding: 10 }),
      floatingSize({
        padding: 10,
        apply({ availableHeight, elements }) {
          elements.floating.style.setProperty(
            "--ds-avail-h",
            `${Math.max(160, Math.floor(availableHeight))}px`,
          );
        },
      }),
    ],
    whileElementsMounted: autoUpdate,
  });

  useEffect(() => {
    if (!point) return;
    refs.setPositionReference({
      getBoundingClientRect: () => ({
        width: 0,
        height: 0,
        x: point.x,
        y: point.y,
        top: point.y,
        right: point.x,
        bottom: point.y,
        left: point.x,
      }),
    });
  }, [point, refs]);

  const role = useRole(context, { role: "menu" });
  const dismiss = useDismiss(context, { escapeKey: false, ancestorScroll: true });
  const listNavigation = useListNavigation(context, {
    listRef: elementsRef,
    activeIndex,
    onNavigate: setActiveIndex,
  });
  const typeahead = useTypeahead(context, {
    listRef: labelsRef,
    onMatch: isOpen ? setActiveIndex : undefined,
    activeIndex,
  });
  const { getFloatingProps, getItemProps } = useInteractions([
    role,
    dismiss,
    listNavigation,
    typeahead,
  ]);

  useOverlayEscape(isOpen, () => setPoint(null));

  const close = useCallback(() => setPoint(null), []);

  const menuContext = useMemo<MenuContextValue>(
    () => ({
      getItemProps,
      activeIndex,
      setActiveIndex,
      setHasFocusInside: noop,
      isOpen,
      closeAll: close,
    }),
    [getItemProps, activeIndex, isOpen, close],
  );

  const panelVariants = useVariants(scaleIn);
  const body = items ? renderMenuSpecs(items) : content;

  return (
    <>
      <div
        className={className}
        onContextMenu={(event) => {
          if (disabled) return;
          event.preventDefault();
          const fromKeyboard = event.clientX === 0 && event.clientY === 0;
          const anchor =
            event.target instanceof HTMLElement ? event.target : event.currentTarget;
          if (fromKeyboard && anchor instanceof HTMLElement) {
            const rect = anchor.getBoundingClientRect();
            setPoint({ x: rect.left + 8, y: rect.top + 8 });
          } else {
            setPoint({ x: event.clientX, y: event.clientY });
          }
          setActiveIndex(null);
          emitOpenChange(true);
        }}
      >
        {children}
      </div>
      <MenuContext.Provider value={menuContext}>
        <FloatingList elementsRef={elementsRef} labelsRef={labelsRef}>
          <AnimatePresence>
            {isOpen ? (
              <FloatingPortal key="context-menu" id={portalId}>
                <FloatingFocusManager context={context} initialFocus={refs.floating} modal>
                  <div
                    ref={refs.setFloating}
                    style={{ ...floatingStyles, width }}
                    {...getFloatingProps({ tabIndex: -1 })}
                    aria-label={ariaLabel ?? "Context menu"}
                    className={cx(Z_CLASS.popover, "outline-none")}
                  >
                    <motion.div
                      variants={panelVariants}
                      initial="hidden"
                      animate="visible"
                      exit="exit"
                      style={{ transformOrigin: transformOrigin(resolvedPlacement) }}
                      className={cx(FLOATING_PANEL, MENU_PANEL, menuClassName)}
                    >
                      <OverlayCloseContext.Provider value={close}>{body}</OverlayCloseContext.Provider>
                    </motion.div>
                  </div>
                </FloatingFocusManager>
              </FloatingPortal>
            ) : null}
          </AnimatePresence>
        </FloatingList>
      </MenuContext.Provider>
    </>
  );
}

/** Right-click / Menu-key menu for any region. */
export function ContextMenu(props: ContextMenuProps) {
  const parentId = useFloatingParentNodeId();
  if (parentId === null) {
    return (
      <FloatingTree>
        <ContextMenuInner {...props} />
      </FloatingTree>
    );
  }
  return <ContextMenuInner {...props} />;
}

/* ==========================================================================
   Toasts
   --------------------------------------------------------------------------
   sonner does the stacking, swipe-to-dismiss and timing; we replace its entire
   visual layer with design-system tokens (via its CSS custom properties, which
   is the only override surface that survives its own stylesheet) and swap in
   our icon set.

   Mount <Toaster /> once at the app root. Call `toast(...)` from anywhere —
   including outside React.
========================================================================== */

export type ToastId = string | number;
export type ToastOptions = ExternalToast;
export type ToastPosition = NonNullable<SonnerToasterProps["position"]>;

export interface ToasterProps extends Omit<SonnerToasterProps, "theme"> {
  /** Defaults to the app's resolved theme. */
  theme?: "light" | "dark" | "system";
}

const TOASTER_TOKEN_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  zIndex: Z.toast,
  "--normal-bg": "var(--ds-surface-overlay)",
  "--normal-text": "var(--ds-content)",
  "--normal-border": "var(--ds-border)",
  "--normal-bg-hover": "var(--ds-surface-hover)",
  "--normal-border-hover": "var(--ds-border-strong)",
  "--success-bg": "var(--ds-success-subtle)",
  "--success-text": "var(--ds-success-fg)",
  "--success-border": "var(--ds-success-border)",
  "--error-bg": "var(--ds-danger-subtle)",
  "--error-text": "var(--ds-danger-fg)",
  "--error-border": "var(--ds-danger-border)",
  "--warning-bg": "var(--ds-warning-subtle)",
  "--warning-text": "var(--ds-warning-fg)",
  "--warning-border": "var(--ds-warning-border)",
  "--info-bg": "var(--ds-info-subtle)",
  "--info-text": "var(--ds-info-fg)",
  "--info-border": "var(--ds-info-border)",
  "--border-radius": "var(--radius-lg)",
  "--width": "22rem",
} as CSSProperties;

/*
 * sonner's own rules are `[data-sonner-toast][data-styled=true] …` — two
 * attribute selectors, which outrank a single utility class. `!` is therefore
 * load-bearing here, not laziness.
 */
const TOAST_CLASSNAMES = {
  toast: cx(
    "!items-start !gap-2.5 !rounded-lg !border !p-3.5 !font-sans !text-body !shadow-e4",
  ),
  content: "!gap-1",
  title: "!text-body !font-medium !leading-5",
  description: "!text-meta !leading-[1.45] !text-content-muted",
  icon: "!mt-px !ml-0 !mr-1.5 !size-4",
  loader: "!text-content-muted",
  actionButton: cx(
    "!h-control-xs !shrink-0 !rounded-md !bg-accent !px-2.5",
    "!text-meta !font-medium !text-accent-fg hover:!bg-accent-hover",
  ),
  cancelButton: cx(
    "!h-control-xs !shrink-0 !rounded-md !bg-surface-sunken !px-2.5",
    "!text-meta !font-medium !text-content-muted hover:!bg-surface-hover",
  ),
  closeButton: cx(
    "!border-border !bg-surface-overlay !text-content-subtle",
    "hover:!border-border-strong hover:!bg-surface-hover hover:!text-content",
  ),
} as const;

const TOAST_ICONS = {
  success: <IconCheckCircle size={16} className="text-success-fg" />,
  error: <IconCloseCircle size={16} className="text-danger-fg" />,
  warning: <IconWarning size={16} className="text-warning-fg" />,
  info: <IconInfo size={16} className="text-info-fg" />,
  loading: <IconSpinner size={16} className="text-content-muted" />,
  close: <IconClose size={13} />,
} as const;

/**
 * Mount once, at the app root, inside <ThemeProvider>.
 *
 *   <Toaster />
 */
export function Toaster({
  theme,
  position = "bottom-right",
  closeButton = true,
  gap = 10,
  visibleToasts = 4,
  duration = 4500,
  offset = 18,
  toastOptions,
  style,
  className,
  ...rest
}: ToasterProps) {
  const resolvedTheme = useResolvedTheme();
  return (
    <SonnerToaster
      theme={theme ?? resolvedTheme}
      position={position}
      closeButton={closeButton}
      gap={gap}
      visibleToasts={visibleToasts}
      duration={duration}
      offset={offset}
      icons={TOAST_ICONS}
      className={cx("constructos-toaster", className)}
      style={{ ...TOASTER_TOKEN_STYLE, ...style }}
      toastOptions={{
        ...toastOptions,
        classNames: { ...TOAST_CLASSNAMES, ...toastOptions?.classNames },
      }}
      {...rest}
    />
  );
}

export type ToastPromiseOptions<T> = NonNullable<Parameters<typeof sonnerToast.promise<T>>[1]>;

/**
 * The app-wide notification API.
 *
 *   toast.success("Submittal issued", { description: "SUB-0142 → Arup" });
 *   toast.error("Upload failed", { action: { label: "Retry", onClick: retry } });
 *   toast.promise(save(), { loading: "Saving…", success: "Saved", error: "Failed" });
 *
 * Every method returns the toast id; pass it to `toast.dismiss(id)`.
 */
export const toast = Object.assign(
  (message: ReactNode, options?: ToastOptions): ToastId => sonnerToast(message, options),
  {
    success: (message: ReactNode, options?: ToastOptions): ToastId =>
      sonnerToast.success(message, options),
    error: (message: ReactNode, options?: ToastOptions): ToastId =>
      sonnerToast.error(message, options),
    warning: (message: ReactNode, options?: ToastOptions): ToastId =>
      sonnerToast.warning(message, options),
    info: (message: ReactNode, options?: ToastOptions): ToastId =>
      sonnerToast.info(message, options),
    /** Neutral, icon-free. */
    message: (message: ReactNode, options?: ToastOptions): ToastId =>
      sonnerToast.message(message, options),
    /** Persists until dismissed or replaced by id. */
    loading: (message: ReactNode, options?: ToastOptions): ToastId =>
      sonnerToast.loading(message, options),
    /** Full control of the rendered node. */
    custom: (render: (id: ToastId) => ReactElement, options?: ToastOptions): ToastId =>
      sonnerToast.custom(render, options),
    /** Swaps loading → success/error as the promise settles. */
    promise: <T,>(promise: Promise<T> | (() => Promise<T>), options: ToastPromiseOptions<T>) =>
      sonnerToast.promise<T>(promise, options),
    dismiss: (id?: ToastId): ToastId => sonnerToast.dismiss(id),
    /** Clear the stack. */
    dismissAll: (): ToastId => sonnerToast.dismiss(),
    getToasts: () => sonnerToast.getToasts(),
  },
);

export type ToastApi = typeof toast;

/* ==========================================================================
   Command surface
   --------------------------------------------------------------------------
   The primitive layer only. It owns the shell, the scoring input, the list
   chrome and the keyboard contract; it deliberately knows nothing about
   ConstructOS routes or actions — the application palette composes those on
   top with <CommandGroup> / <CommandItem>.

   For an inline combobox (inside a Popover, say) use <CommandRoot> directly.
========================================================================== */

export type CommandFilter = (value: string, search: string, keywords?: string[]) => number;

export type CommandRootProps = ComponentPropsWithoutRef<typeof CmdkRoot>;

/** Unstyled-shell cmdk root with our list/typography defaults applied. */
export const CommandRoot = forwardRef<HTMLDivElement, CommandRootProps>(
  function CommandRoot({ className, loop = true, ...rest }, ref) {
    return (
      <CmdkRoot
        ref={ref}
        loop={loop}
        className={cx("flex w-full flex-col overflow-hidden text-content", className)}
        {...rest}
      />
    );
  },
);

export interface CommandInputProps
  extends Omit<ComponentPropsWithoutRef<typeof CmdkInput>, "className" | "size"> {
  /** Chips rendered left of the caret — scope, active page, filters. */
  badges?: ReactNode;
  icon?: IconLike;
  className?: string;
  wrapperClassName?: string;
  trailing?: ReactNode;
  size?: "md" | "lg";
}

export const CommandInput = forwardRef<HTMLInputElement, CommandInputProps>(
  function CommandInput(
    { badges, icon = IconSearch, className, wrapperClassName, trailing, size = "md", ...rest },
    ref,
  ) {
    return (
      <div
        className={cx(
          "flex shrink-0 items-center gap-2.5 border-b border-border px-3.5",
          size === "lg" ? "h-14" : "h-12",
          wrapperClassName,
        )}
      >
        <span className="shrink-0 text-content-subtle">{renderIcon(icon, 17)}</span>
        {badges ? <span className="flex shrink-0 items-center gap-1.5">{badges}</span> : null}
        <CmdkInput
          ref={ref}
          className={cx(
            "min-w-0 flex-1 bg-transparent text-content outline-none",
            "placeholder:text-content-subtle disabled:text-content-disabled",
            size === "lg" ? "text-base" : "text-body",
            className,
          )}
          {...rest}
        />
        {trailing ? <span className="flex shrink-0 items-center gap-1.5">{trailing}</span> : null}
      </div>
    );
  },
);

export type CommandListProps = ComponentPropsWithoutRef<typeof CmdkList>;

export const CommandList = forwardRef<HTMLDivElement, CommandListProps>(
  function CommandList({ className, ...rest }, ref) {
    return (
      <CmdkList
        ref={ref}
        className={cx(
          "max-h-[min(24rem,58dvh)] min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5",
          "scroll-py-1.5",
          className,
        )}
        {...rest}
      />
    );
  },
);

export type CommandGroupProps = ComponentPropsWithoutRef<typeof CmdkGroup>;

export const CommandGroup = forwardRef<HTMLDivElement, CommandGroupProps>(
  function CommandGroup({ className, ...rest }, ref) {
    return (
      <CmdkGroup
        ref={ref}
        className={cx(
          "overflow-hidden text-content",
          "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2.5 [&_[cmdk-group-heading]]:pb-1.5",
          "[&_[cmdk-group-heading]]:text-label [&_[cmdk-group-heading]]:uppercase",
          "[&_[cmdk-group-heading]]:text-content-subtle [&_[cmdk-group-heading]]:select-none",
          className,
        )}
        {...rest}
      />
    );
  },
);

export interface CommandItemProps extends ComponentPropsWithoutRef<typeof CmdkItem> {
  icon?: IconLike;
  /** e.g. "⌘+K". Rendered as keycaps on the right. */
  shortcut?: string;
  /** Secondary line under the label. */
  description?: ReactNode;
  /** Right-hand slot rendered before any shortcut — a badge, a path, a date. */
  trailing?: ReactNode;
  destructive?: boolean;
}

export const CommandItem = forwardRef<HTMLDivElement, CommandItemProps>(function CommandItem(
  { icon, shortcut, description, trailing, destructive = false, className, children, ...rest },
  ref,
) {
  return (
    <CmdkItem
      ref={ref}
      className={cx(
        "relative flex cursor-default select-none items-center gap-2.5 rounded-md px-2 py-2",
        "text-body outline-none transition-colors duration-instant",
        destructive
          ? "text-danger-fg data-[selected=true]:bg-danger-subtle"
          : "text-content data-[selected=true]:bg-surface-hover",
        "data-[disabled=true]:pointer-events-none data-[disabled=true]:text-content-disabled",
        className,
      )}
      {...rest}
    >
      {icon ? (
        <span
          className={cx(
            "shrink-0",
            destructive ? "text-danger-fg" : "text-content-subtle",
          )}
        >
          {renderIcon(icon, 15)}
        </span>
      ) : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{children}</span>
        {description ? (
          <span className="mt-0.5 block truncate text-meta text-content-subtle">
            {description}
          </span>
        ) : null}
      </span>
      {trailing ? (
        <span className="shrink-0 text-meta text-content-subtle">{trailing}</span>
      ) : null}
      {shortcut ? <ShortcutKeys keys={shortcut} /> : null}
    </CmdkItem>
  );
});

export type CommandSeparatorProps = ComponentPropsWithoutRef<typeof CmdkSeparator>;

export const CommandSeparator = forwardRef<HTMLDivElement, CommandSeparatorProps>(
  function CommandSeparator({ className, ...rest }, ref) {
    return <CmdkSeparator ref={ref} className={cx("my-1 h-px bg-border-subtle", className)} {...rest} />;
  },
);

export type CommandEmptyProps = ComponentPropsWithoutRef<typeof CmdkEmpty>;

export const CommandEmpty = forwardRef<HTMLDivElement, CommandEmptyProps>(
  function CommandEmpty({ className, children, ...rest }, ref) {
    return (
      <CmdkEmpty
        ref={ref}
        className={cx(
          "flex flex-col items-center justify-center gap-1 px-6 py-10 text-center",
          className,
        )}
        {...rest}
      >
        {children ?? (
          <>
            <IconSearch size={20} className="text-content-subtle" />
            <p className="text-body text-content-muted">No matches</p>
            <p className="text-meta text-content-subtle">Try a different search.</p>
          </>
        )}
      </CmdkEmpty>
    );
  },
);

export type CommandLoadingProps = ComponentPropsWithoutRef<typeof CmdkLoading>;

export const CommandLoading = forwardRef<HTMLDivElement, CommandLoadingProps>(
  function CommandLoading({ className, children, ...rest }, ref) {
    return (
      <CmdkLoading ref={ref} {...rest}>
        <div
          className={cx(
            "flex items-center justify-center gap-2 px-4 py-6 text-body text-content-muted",
            className,
          )}
        >
          <IconSpinner size={15} />
          {children ?? "Searching…"}
        </div>
      </CmdkLoading>
    );
  },
);

/** Keycap cluster, for use in a command footer or an item's right rail. */
export function CommandShortcut({ keys, className }: { keys: string; className?: string }) {
  return <ShortcutKeys keys={keys} className={className} />;
}

/** The hint strip along the bottom of the palette. */
export function CommandFooter({
  children,
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "flex shrink-0 items-center gap-3 border-t border-border bg-surface-sunken/60 px-3.5 py-2",
        "text-meta text-content-subtle",
        className,
      )}
    >
      {children}
    </div>
  );
}

export { useCommandState };

export interface CommandMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children?: ReactNode;

  /** Accessible name for the palette. */
  label?: string;
  placeholder?: string;
  /** Chips left of the caret — the current page/scope in a multi-level palette. */
  badges?: ReactNode;
  inputTrailing?: ReactNode;
  hideInput?: boolean;

  search?: string;
  onSearchChange?: (search: string) => void;
  value?: string;
  onValueChange?: (value: string) => void;
  shouldFilter?: boolean;
  filter?: CommandFilter;
  loop?: boolean;

  loading?: boolean;
  emptyMessage?: ReactNode;
  footer?: ReactNode;

  /** `false` hands the whole body to `children` (no CommandList wrapper). */
  list?: boolean;
  size?: "md" | "lg";
  /** Fires on Backspace in an empty input — pop a page in a nested palette. */
  onEmptyBackspace?: () => void;

  className?: string;
  listClassName?: string;
  overlayClassName?: string;
  portalId?: string;
}

/**
 * The command palette shell: portal, scrim, focus trap, scroll lock, Escape,
 * and a cmdk root wired for scoring. The application palette supplies the
 * groups and items.
 */
export function CommandMenu({
  open,
  onOpenChange,
  children,
  label = "Command palette",
  placeholder = "Search commands, records and people…",
  badges,
  inputTrailing,
  hideInput = false,
  search,
  onSearchChange,
  value,
  onValueChange,
  shouldFilter = true,
  filter,
  loop = true,
  loading = false,
  emptyMessage,
  footer,
  list = true,
  size = "lg",
  onEmptyBackspace,
  className,
  listClassName,
  overlayClassName,
  portalId = OVERLAY_PORTAL_ID,
}: CommandMenuProps) {
  const { refs, context } = useFloating({
    open,
    onOpenChange,
  });
  const dismiss = useDismiss(context, {
    escapeKey: false,
    outsidePress: true,
    outsidePressEvent: "mousedown",
  });
  const role = useRole(context, { role: "dialog" });
  const { getFloatingProps } = useInteractions([dismiss, role]);

  useOverlayEscape(open, () => onOpenChange(false));

  const panelVariants = useVariants(modalPanel);
  const scrimVariants = useVariants(overlayFade);
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  const body = (
    <>
      {emptyMessage === undefined ? <CommandEmpty /> : <CommandEmpty>{emptyMessage}</CommandEmpty>}
      {loading ? <CommandLoading /> : null}
      {children}
    </>
  );

  return (
    <AnimatePresence>
      {open ? (
        <FloatingPortal key="command" id={portalId}>
          <FloatingOverlay
            lockScroll
            className={cx(Z_CLASS.command, "overscroll-contain", overlayClassName)}
          >
            <motion.div
              aria-hidden
              variants={scrimVariants}
              initial="hidden"
              animate="visible"
              exit="exit"
              className={cx("fixed inset-0", SCRIM)}
            />
            <div className="relative flex min-h-full w-full items-start justify-center p-4 pt-[10vh] sm:p-6 sm:pt-[12vh]">
              <FloatingFocusManager context={context} modal initialFocus={0} returnFocus>
                <div
                  ref={refs.setFloating}
                  {...getFloatingProps()}
                  aria-label={label}
                  aria-modal="true"
                  className={cx("w-full", size === "lg" ? "max-w-2xl" : "max-w-xl")}
                >
                  <motion.div
                    variants={panelVariants}
                    initial="hidden"
                    animate="visible"
                    exit="exit"
                    className={cx(
                      "flex max-h-[min(34rem,76dvh)] flex-col overflow-hidden rounded-xl",
                      "border border-border bg-surface-overlay shadow-e5",
                      "supports-[backdrop-filter]:bg-surface-overlay/95 supports-[backdrop-filter]:backdrop-blur-xl",
                      className,
                    )}
                  >
                    <OverlayCloseContext.Provider value={close}>
                      <CommandRoot
                        label={label}
                        shouldFilter={shouldFilter}
                        filter={filter}
                        loop={loop}
                        value={value}
                        onValueChange={onValueChange}
                        className="min-h-0 flex-1"
                        onKeyDown={(event) => {
                          if (
                            event.key === "Backspace" &&
                            onEmptyBackspace &&
                            (search === undefined || search.length === 0)
                          ) {
                            const target = event.target as HTMLElement | null;
                            if (target instanceof HTMLInputElement && target.value === "") {
                              event.preventDefault();
                              onEmptyBackspace();
                            }
                          }
                        }}
                      >
                        {hideInput ? null : (
                          <CommandInput
                            autoFocus
                            size={size}
                            placeholder={placeholder}
                            badges={badges}
                            trailing={inputTrailing}
                            value={search}
                            onValueChange={onSearchChange}
                          />
                        )}
                        {list ? (
                          <CommandList className={listClassName}>{body}</CommandList>
                        ) : (
                          body
                        )}
                      </CommandRoot>
                      {footer ? <CommandFooter>{footer}</CommandFooter> : null}
                    </OverlayCloseContext.Provider>
                  </motion.div>
                </div>
              </FloatingFocusManager>
            </div>
          </FloatingOverlay>
        </FloatingPortal>
      ) : null}
    </AnimatePresence>
  );
}

/* ==========================================================================
   Tour / Coachmark
   --------------------------------------------------------------------------
   Deliberately small: an anchored card, an optional spotlight cut out of the
   scrim, and arrow-key navigation. No step registry, no persistence — those
   belong to the feature that runs the tour.
========================================================================== */

export type TourTarget =
  | string
  | HTMLElement
  | (() => HTMLElement | null)
  | RefObject<HTMLElement | null>
  | null
  | undefined;

function resolveTourTarget(target: TourTarget): HTMLElement | null {
  if (!target) return null;
  if (typeof window === "undefined") return null;
  if (typeof target === "string") return document.querySelector<HTMLElement>(target);
  if (typeof target === "function") return target();
  if (target instanceof HTMLElement) return target;
  if (typeof target === "object" && "current" in target) return target.current;
  return null;
}

/** Resolve a target, retrying for a few frames while the page settles. */
function useTourAnchor(target: TourTarget, active: boolean): HTMLElement | null {
  const [element, setElement] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!active) {
      setElement(null);
      return;
    }
    let frame = 0;
    let attempts = 0;
    const find = (): void => {
      const found = resolveTourTarget(target);
      if (found) {
        setElement(found);
        return;
      }
      setElement(null);
      attempts += 1;
      if (attempts < 90) frame = requestAnimationFrame(find);
    };
    find();
    return () => {
      if (frame) cancelAnimationFrame(frame);
    };
  }, [target, active]);
  return element;
}

/** Live viewport rect of an element, tracked through scroll, resize and layout. */
function useElementRect(element: HTMLElement | null, active: boolean): DOMRect | null {
  const [rect, setRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    if (!element || !active) {
      setRect(null);
      return;
    }
    let frame = 0;
    const measure = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setRect(element.getBoundingClientRect()));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [element, active]);
  return rect;
}

export interface CoachmarkProps {
  open: boolean;
  target?: TourTarget;

  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;

  placement?: Placement;
  /** Cut the target out of the scrim and ring it. Default `true`. */
  spotlight?: boolean;
  spotlightPadding?: number;
  spotlightRadius?: number;
  /** Skip the dimming layer entirely (for a single hint on a live page). */
  scrimless?: boolean;
  showArrow?: boolean;
  /** Scroll the target into view on open. Default `true`. */
  scrollIntoView?: boolean;

  onDismiss?: () => void;
  dismissLabel?: ReactNode;
  onAction?: () => void;
  actionLabel?: ReactNode;
  onBack?: () => void;
  backLabel?: ReactNode;
  /** 1-based progress, e.g. `{ index: 0, total: 4 }` (index is 0-based). */
  progress?: { index: number; total: number };
  /** Replaces the whole action row. */
  footer?: ReactNode;

  width?: number;
  className?: string;
  portalId?: string;
}

export function Coachmark({
  open,
  target,
  title,
  description,
  children,
  placement = "bottom",
  spotlight = true,
  spotlightPadding = 8,
  spotlightRadius = 10,
  scrimless = false,
  showArrow = true,
  scrollIntoView = true,
  onDismiss,
  dismissLabel = "Skip",
  onAction,
  actionLabel = "Next",
  onBack,
  backLabel = "Back",
  progress,
  footer,
  width = 328,
  className,
  portalId = OVERLAY_PORTAL_ID,
}: CoachmarkProps) {
  const anchor = useTourAnchor(target, open);
  const rect = useElementRect(anchor, open && spotlight && !scrimless);
  const arrowRef = useRef<SVGSVGElement>(null);
  const titleId = useId();
  const emitDismiss = useEvent(onDismiss);

  const { refs, floatingStyles, context, placement: resolvedPlacement } = useFloating({
    open,
    onOpenChange: (next) => {
      if (!next) emitDismiss();
    },
    placement,
    middleware: [
      offset(spotlightPadding + (showArrow ? 10 : 6)),
      flip({ padding: 12 }),
      shift({ padding: 12 }),
      showArrow ? arrow({ element: arrowRef }) : null,
    ],
    whileElementsMounted: autoUpdate,
  });

  const role = useRole(context, { role: "dialog" });
  const { getFloatingProps } = useInteractions([role]);

  useEffect(() => {
    if (anchor) refs.setPositionReference(anchor);
  }, [anchor, refs]);

  useEffect(() => {
    if (!open || !anchor || !scrollIntoView) return;
    anchor.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
  }, [open, anchor, scrollIntoView]);

  useOverlayEscape(open, () => emitDismiss());

  const cardVariants = useVariants(scaleIn);
  const scrimVariants = useVariants(fade);
  const hasAnchor = anchor !== null;

  const card = (
    <motion.div
      variants={cardVariants}
      initial="hidden"
      animate="visible"
      exit="exit"
      style={{
        width,
        transformOrigin: hasAnchor ? transformOrigin(resolvedPlacement) : "center",
      }}
      className={cx(
        "relative rounded-xl border border-border bg-surface-overlay p-4 shadow-e4",
        className,
      )}
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-px grid size-7 shrink-0 place-items-center rounded-lg bg-accent-subtle text-accent-subtle-fg">
          <IconInfo size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-body font-semibold text-content">
            {title}
          </h2>
          {description ? (
            <p className="mt-1 text-body leading-[1.5] text-content-muted">{description}</p>
          ) : null}
          {children ? <div className="mt-2.5">{children}</div> : null}
        </div>
        {onDismiss ? (
          <OverlayCloseButton onClick={() => emitDismiss()} label="Dismiss" className="-mt-1 -mr-1" />
        ) : null}
      </div>

      {footer ?? (
        <div className="mt-4 flex items-center gap-2">
          {progress && progress.total > 1 ? (
            <div className="flex items-center gap-1.5" aria-hidden>
              {Array.from({ length: progress.total }, (_, index) => (
                <span
                  key={index}
                  className={cx(
                    "h-1.5 rounded-full transition-all duration-base",
                    index === progress.index ? "w-4 bg-accent" : "w-1.5 bg-border-strong",
                  )}
                />
              ))}
            </div>
          ) : null}
          <span className="ml-auto flex items-center gap-2">
            {onDismiss ? (
              <Button variant="ghost" size="sm" onClick={() => emitDismiss()}>
                {dismissLabel}
              </Button>
            ) : null}
            {onBack ? (
              <Button variant="secondary" size="sm" onClick={onBack}>
                {backLabel}
              </Button>
            ) : null}
            {onAction ? (
              <Button variant="primary" size="sm" onClick={onAction}>
                {actionLabel}
              </Button>
            ) : null}
          </span>
        </div>
      )}

      {showArrow && hasAnchor ? (
        <FloatingArrow
          ref={arrowRef}
          context={context}
          width={13}
          height={6}
          tipRadius={1.5}
          className="fill-surface-overlay [&>path:first-of-type]:stroke-border"
          strokeWidth={1}
        />
      ) : null}
    </motion.div>
  );

  return (
    <AnimatePresence>
      {open ? (
        <FloatingPortal key="coachmark" id={portalId}>
          {scrimless ? null : (
            <motion.div
              aria-hidden
              variants={scrimVariants}
              initial="hidden"
              animate="visible"
              exit="exit"
              className={cx("fixed inset-0", Z_CLASS.overlay)}
            >
              {spotlight && rect ? (
                <div
                  className="absolute rounded-lg ring-2 ring-accent/70 transition-all duration-base ease-emphasized"
                  style={{
                    top: rect.top - spotlightPadding,
                    left: rect.left - spotlightPadding,
                    width: rect.width + spotlightPadding * 2,
                    height: rect.height + spotlightPadding * 2,
                    borderRadius: spotlightRadius,
                    boxShadow: "0 0 0 9999px var(--ds-scrim)",
                  }}
                />
              ) : (
                <div className={cx("absolute inset-0", SCRIM)} />
              )}
            </motion.div>
          )}

          <FloatingFocusManager
            context={context}
            modal={!scrimless}
            initialFocus={0}
            returnFocus
            visuallyHiddenDismiss="Dismiss"
          >
            {hasAnchor ? (
              <div
                ref={refs.setFloating}
                style={floatingStyles}
                {...getFloatingProps()}
                aria-labelledby={titleId}
                className={cx(Z_CLASS.command, "outline-none")}
              >
                {card}
              </div>
            ) : (
              <div
                ref={refs.setFloating}
                {...getFloatingProps()}
                aria-labelledby={titleId}
                className={cx(
                  "pointer-events-none fixed inset-0 grid place-items-center p-6 outline-none",
                  Z_CLASS.command,
                )}
              >
                <div className="pointer-events-auto">{card}</div>
              </div>
            )}
          </FloatingFocusManager>
        </FloatingPortal>
      ) : null}
    </AnimatePresence>
  );
}

export interface TourStep {
  id?: string;
  /** CSS selector, element, ref or getter. Omit for a centred intro step. */
  target?: TourTarget;
  title: ReactNode;
  content?: ReactNode;
  placement?: Placement;
  spotlight?: boolean;
  spotlightPadding?: number;
}

export interface TourProps {
  steps: TourStep[];
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Controlled step index. */
  step?: number;
  defaultStep?: number;
  onStepChange?: (index: number) => void;
  onFinish?: () => void;
  onSkip?: () => void;
  labels?: Partial<{ next: string; back: string; skip: string; finish: string }>;
  showProgress?: boolean;
  scrimless?: boolean;
  width?: number;
  portalId?: string;
}

/**
 * A guided walkthrough. Arrow keys move between steps; Escape skips.
 *
 *   <Tour open={showTour} onOpenChange={setShowTour} steps={[
 *     { target: "#nav-rfis", title: "RFIs live here", content: "…" },
 *     { target: "#cmd-k",   title: "Jump anywhere", content: "…" },
 *   ]} />
 */
export function Tour({
  steps,
  open,
  onOpenChange,
  step: controlledStep,
  defaultStep = 0,
  onStepChange,
  onFinish,
  onSkip,
  labels,
  showProgress = true,
  scrimless = false,
  width,
  portalId,
}: TourProps) {
  const [index, setIndex] = useControllableState(controlledStep, defaultStep, onStepChange);
  const emitOpenChange = useEvent(onOpenChange);
  const emitFinish = useEvent(onFinish);
  const emitSkip = useEvent(onSkip);

  const total = steps.length;
  const safeIndex = Math.min(Math.max(index, 0), Math.max(total - 1, 0));
  const current = steps[safeIndex];
  const isLast = safeIndex >= total - 1;

  const finish = useCallback(() => {
    emitFinish();
    emitOpenChange(false);
  }, [emitFinish, emitOpenChange]);

  const skip = useCallback(() => {
    emitSkip();
    emitOpenChange(false);
  }, [emitSkip, emitOpenChange]);

  const next = useCallback(() => {
    if (isLast) finish();
    else setIndex(safeIndex + 1);
  }, [isLast, finish, setIndex, safeIndex]);

  const back = useCallback(() => {
    if (safeIndex > 0) setIndex(safeIndex - 1);
  }, [setIndex, safeIndex]);

  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "ArrowRight") {
        event.preventDefault();
        next();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        back();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, next, back]);

  if (!current) return null;

  return (
    <Coachmark
      key={current.id ?? safeIndex}
      open={open}
      target={current.target}
      title={current.title}
      description={current.content}
      placement={current.placement}
      spotlight={current.spotlight ?? true}
      spotlightPadding={current.spotlightPadding}
      scrimless={scrimless}
      width={width}
      portalId={portalId}
      progress={showProgress ? { index: safeIndex, total } : undefined}
      onDismiss={skip}
      dismissLabel={labels?.skip ?? "Skip"}
      onAction={next}
      actionLabel={isLast ? (labels?.finish ?? "Done") : (labels?.next ?? "Next")}
      onBack={safeIndex > 0 ? back : undefined}
      backLabel={labels?.back ?? "Back"}
    />
  );
}

/* ==========================================================================
   AppErrorBoundary
   --------------------------------------------------------------------------
   A render error is a product surface, not a stack trace. The fallback states
   plainly what happened, offers a real retry (remount the subtree, no page
   reload), and keeps the technical detail behind a disclosure that can be
   copied in one click for a bug report.
========================================================================== */

export interface ErrorFallbackContext {
  error: Error;
  errorInfo: ErrorInfo | null;
  /** Remounts the boundary's children. */
  reset: () => void;
}

export interface ErrorFallbackProps extends ErrorFallbackContext {
  title?: ReactNode;
  description?: ReactNode;
  /** Defaults to on in development, off in production builds. */
  showDetails?: boolean;
  /** `page` fills the region; `inline` is a compact card for a widget slot. */
  variant?: "page" | "inline";
  /** Extra buttons rendered after "Try again". */
  actions?: ReactNode;
  className?: string;
}

/** The designed fallback. Exported so a feature can reuse it outside a boundary. */
export function ErrorFallback({
  error,
  errorInfo,
  reset,
  title = "Something went wrong",
  description = "This view failed to render. Your work has not been lost — try again, and if it keeps happening send us the details below.",
  showDetails = import.meta.env.DEV,
  variant = "page",
  actions,
  className,
}: ErrorFallbackProps) {
  const [copied, setCopied] = useState(false);

  const details = useMemo(() => {
    const parts = [
      `Message: ${error.message}`,
      error.stack ? `\nStack:\n${error.stack}` : "",
      errorInfo?.componentStack ? `\nComponent stack:${errorInfo.componentStack}` : "",
      typeof window !== "undefined" ? `\nURL: ${window.location.href}` : "",
    ];
    return parts.filter(Boolean).join("\n");
  }, [error, errorInfo]);

  const copy = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    void navigator.clipboard.writeText(details).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    });
  }, [details]);

  return (
    <div
      role="alert"
      aria-live="assertive"
      className={cx(
        "relative grid w-full place-items-center overflow-hidden",
        variant === "page" ? "min-h-[60dvh] px-page-x py-page-y" : "p-card",
        className,
      )}
    >
      {variant === "page" ? (
        <div
          aria-hidden
          className="grid-bg pointer-events-none absolute inset-0 opacity-60 mask-fade-y"
        />
      ) : null}

      <div
        className={cx(
          "relative w-full rounded-xl border border-border bg-surface-raised shadow-e1",
          variant === "page" ? "max-w-prose p-6 sm:p-8" : "p-4",
        )}
      >
        <div className={cx(variant === "page" ? "text-center" : "flex items-start gap-3")}>
          <span
            className={cx(
              "grid shrink-0 place-items-center rounded-xl bg-danger-subtle text-danger-fg",
              variant === "page" ? "mx-auto size-11" : "size-8",
            )}
          >
            <IconError size={variant === "page" ? 22 : 16} />
          </span>
          <div className="min-w-0">
            <h2
              className={cx(
                "font-semibold tracking-[-0.011em] text-content",
                variant === "page" ? "mt-4 text-lg" : "text-body",
              )}
            >
              {title}
            </h2>
            <p
              className={cx(
                "text-body text-content-muted",
                variant === "page" ? "mt-1.5" : "mt-1",
              )}
            >
              {description}
            </p>
          </div>
        </div>

        <div
          className={cx(
            "flex flex-wrap items-center gap-2",
            variant === "page" ? "mt-6 justify-center" : "mt-3.5",
          )}
        >
          <Button variant="primary" icon={IconRefresh} onClick={reset}>
            Try again
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              if (typeof window !== "undefined") window.location.reload();
            }}
          >
            Reload page
          </Button>
          {actions}
        </div>

        {showDetails ? (
          <details className="group mt-5 text-left">
            <summary
              className={cx(
                "flex cursor-pointer list-none items-center gap-1.5 rounded-md py-1",
                "text-meta font-medium text-content-subtle select-none",
                "hover:text-content marker:content-none [&::-webkit-details-marker]:hidden",
              )}
            >
              <IconChevronRight
                size={13}
                className="transition-transform duration-fast group-open:rotate-90"
              />
              Technical details
            </summary>
            <div className="mt-2 overflow-hidden rounded-md border border-border-subtle bg-code-bg">
              <div className="flex items-center justify-between gap-2 border-b border-border-subtle px-3 py-1.5">
                <span className="truncate font-mono text-code text-danger-fg">
                  {error.name}: {error.message}
                </span>
                <button
                  type="button"
                  onClick={copy}
                  className={cx(
                    "inline-flex shrink-0 items-center gap-1 rounded-xs px-1.5 py-0.5",
                    "text-meta text-content-subtle transition-colors duration-fast",
                    "hover:bg-surface-hover hover:text-content",
                  )}
                >
                  {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <pre className="max-h-56 overflow-auto px-3 py-2 font-mono text-code leading-[1.5] whitespace-pre-wrap text-content-muted">
                {details}
              </pre>
            </div>
          </details>
        ) : null}
      </div>
    </div>
  );
}

export interface AppErrorBoundaryProps {
  children: ReactNode;
  /** A node, or a render function receiving `{ error, errorInfo, reset }`. */
  fallback?: ReactNode | ((context: ErrorFallbackContext) => ReactNode);
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
  onReset?: () => void;
  /** Any change to these values clears the error and remounts children. */
  resetKeys?: readonly unknown[];
  title?: ReactNode;
  description?: ReactNode;
  showDetails?: boolean;
  variant?: "page" | "inline";
  actions?: ReactNode;
  className?: string;
}

interface AppErrorBoundaryState {
  error: Error | null;
  errorInfo: ErrorInfo | null;
  /** Bumped on reset so children remount cleanly. */
  generation: number;
}

/**
 * Wrap routes, panels and any subtree whose failure should not take the app
 * down with it.
 *
 *   <AppErrorBoundary resetKeys={[projectId]}>
 *     <ProjectDashboard />
 *   </AppErrorBoundary>
 */
export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  override state: AppErrorBoundaryState = { error: null, errorInfo: null, generation: 0 };

  static getDerivedStateFromError(error: Error): Partial<AppErrorBoundaryState> {
    return { error };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    this.setState({ errorInfo });
    this.props.onError?.(error, errorInfo);
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.error("[AppErrorBoundary]", error, errorInfo);
    }
  }

  override componentDidUpdate(previous: AppErrorBoundaryProps): void {
    if (this.state.error === null) return;
    const before = previous.resetKeys;
    const after = this.props.resetKeys;
    if (!before || !after) return;
    const changed =
      before.length !== after.length || after.some((value, index) => !Object.is(value, before[index]));
    if (changed) this.reset();
  }

  reset = (): void => {
    this.props.onReset?.();
    this.setState((current) => ({
      error: null,
      errorInfo: null,
      generation: current.generation + 1,
    }));
  };

  override render(): ReactNode {
    const { error, errorInfo, generation } = this.state;
    const { children, fallback, title, description, showDetails, variant, actions, className } =
      this.props;

    if (error === null) return <div key={generation} className="contents">{children}</div>;

    if (typeof fallback === "function") {
      return fallback({ error, errorInfo, reset: this.reset });
    }
    if (fallback !== undefined) return fallback;

    return (
      <ErrorFallback
        error={error}
        errorInfo={errorInfo}
        reset={this.reset}
        title={title}
        description={description}
        showDetails={showDetails}
        variant={variant}
        actions={actions}
        className={className}
      />
    );
  }
}
