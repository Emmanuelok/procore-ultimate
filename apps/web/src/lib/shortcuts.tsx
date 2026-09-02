/**
 * shortcuts.tsx — the app-wide keyboard layer.
 *
 * One window listener, one registry. Anything in the app can claim a binding
 * with `useShortcut(...)`; every claim automatically appears in the help
 * overlay ("?"), so the documentation cannot drift from the behaviour.
 *
 *   <ShortcutsProvider>            mount once, inside the router
 *   useShortcut({ … })             claim a binding for the life of a component
 *   useShortcuts().openHelp()      open the cheat sheet from a button
 *
 * Two shapes of binding:
 *
 *   combo     { key: "k", mod: true }      ⌘K / Ctrl+K
 *   sequence  ["g", "d"]                   press g, then d (Vim/Linear style)
 *
 * NOTHING fires while the user is typing. A plain-key binding is suppressed
 * inside <input>, <textarea>, <select> and any contenteditable region; only
 * bindings that carry ⌘/Ctrl (or opt in explicitly) survive there, which is
 * what users expect of ⌘K.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import { Kbd, Modal } from "../ui";
import { cx } from "../ui/cx";
import { Z_CLASS } from "../ui/tokens";
import { IconKeyboard } from "../ui/icons";

/* ==========================================================================
   Platform
========================================================================== */

const IS_APPLE =
  typeof navigator !== "undefined" &&
  /mac|iphone|ipad|ipod/i.test(navigator.userAgent ?? "");

/** "⌘" on Apple hardware, "Ctrl" everywhere else. */
export const MOD_LABEL = IS_APPLE ? "⌘" : "Ctrl";

/* ==========================================================================
   Types
========================================================================== */

export interface ShortcutCombo {
  /** `event.key`, matched case-insensitively. */
  key: string;
  /** Requires ⌘ on Apple or Ctrl elsewhere. */
  mod?: boolean;
  /** Only checked when defined. */
  shift?: boolean;
  alt?: boolean;
}

export interface ShortcutBinding {
  /** Stable identity. Re-registering the same id replaces the binding. */
  id: string;
  /** What it does, in the help overlay. */
  label: string;
  /** Help-overlay section. */
  group: string;
  /** Keycaps shown in the overlay, e.g. ["G", "then", "D"]. */
  keys: readonly string[];
  run: (event: KeyboardEvent) => void;
  combo?: ShortcutCombo;
  /** Chord: every key in order, within the chord window. */
  sequence?: readonly string[];
  /** Fire even while the user is typing. Defaults to true for ⌘/Ctrl combos. */
  allowInInput?: boolean;
  /** Swallow the browser default. Default true; Escape opts out. */
  preventDefault?: boolean;
  /** Active but undocumented. */
  hidden?: boolean;
}

interface ShortcutsContextValue {
  register: (binding: ShortcutBinding) => () => void;
  list: () => ShortcutBinding[];
  openHelp: () => void;
  closeHelp: () => void;
  helpOpen: boolean;
  /** Bumped whenever the registry changes, so consumers can re-read. */
  version: number;
}

const ShortcutsContext = createContext<ShortcutsContextValue | null>(null);

/* ==========================================================================
   Target inspection
========================================================================== */

/** True when keystrokes belong to the thing the user is typing into. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.closest('[contenteditable="true"], [role="textbox"]') !== null;
}

function matchesCombo(event: KeyboardEvent, combo: ShortcutCombo): boolean {
  if (event.key.toLowerCase() !== combo.key.toLowerCase()) return false;
  const modPressed = IS_APPLE ? event.metaKey : event.ctrlKey;
  const otherMod = IS_APPLE ? event.ctrlKey : event.metaKey;
  if (combo.mod) {
    if (!modPressed) return false;
  } else if (modPressed || otherMod) {
    return false;
  }
  if (combo.shift !== undefined && event.shiftKey !== combo.shift) return false;
  if (combo.alt !== undefined && event.altKey !== combo.alt) return false;
  if (combo.alt === undefined && event.altKey) return false;
  return true;
}

function allowsTyping(binding: ShortcutBinding): boolean {
  return binding.allowInInput ?? Boolean(binding.combo?.mod);
}

/** How long a chord stays open, in ms. */
const CHORD_WINDOW = 1400;

/* ==========================================================================
   Provider
========================================================================== */

export interface ShortcutsProviderProps {
  children: ReactNode;
  /** Turn the whole layer off (e.g. on the auth screens). */
  disabled?: boolean;
}

export function ShortcutsProvider({ children, disabled = false }: ShortcutsProviderProps) {
  const registry = useRef(new Map<string, ShortcutBinding>());
  const [version, setVersion] = useState(0);
  const [helpOpen, setHelpOpen] = useState(false);
  const [pending, setPending] = useState<readonly string[]>([]);
  const pendingRef = useRef<readonly string[]>([]);
  const chordTimer = useRef<number | null>(null);
  const navigate = useNavigate();

  const clearChord = useCallback(() => {
    if (chordTimer.current !== null) {
      window.clearTimeout(chordTimer.current);
      chordTimer.current = null;
    }
    pendingRef.current = [];
    setPending([]);
  }, []);

  const setChord = useCallback(
    (keys: readonly string[]) => {
      if (chordTimer.current !== null) window.clearTimeout(chordTimer.current);
      pendingRef.current = keys;
      setPending(keys);
      chordTimer.current = window.setTimeout(() => {
        pendingRef.current = [];
        setPending([]);
        chordTimer.current = null;
      }, CHORD_WINDOW);
    },
    [],
  );

  const register = useCallback((binding: ShortcutBinding) => {
    registry.current.set(binding.id, binding);
    setVersion((n) => n + 1);
    return () => {
      const current = registry.current.get(binding.id);
      if (current === binding) registry.current.delete(binding.id);
      setVersion((n) => n + 1);
    };
  }, []);

  const list = useCallback(() => [...registry.current.values()], []);
  const openHelp = useCallback(() => setHelpOpen(true), []);
  const closeHelp = useCallback(() => setHelpOpen(false), []);

  /* -- the single listener ---------------------------------------------- */
  useEffect(() => {
    if (disabled) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing) return;
      const typing = isTypingTarget(event.target);
      const bindings = [...registry.current.values()];

      /* Escape always resolves the pending chord first. */
      if (event.key === "Escape" && pendingRef.current.length > 0) {
        clearChord();
      }

      /* 1. combos */
      for (const binding of bindings) {
        if (!binding.combo) continue;
        if (typing && !allowsTyping(binding)) continue;
        if (!matchesCombo(event, binding.combo)) continue;
        if (binding.preventDefault !== false) event.preventDefault();
        clearChord();
        binding.run(event);
        return;
      }

      /* 2. chords — plain keys only, never while typing */
      if (typing) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const key = event.key.toLowerCase();
      if (key.length !== 1) return;

      const candidate = [...pendingRef.current, key];
      const sequences = bindings.filter((binding) => binding.sequence?.length);

      const exact = sequences.find(
        (binding) =>
          binding.sequence!.length === candidate.length &&
          binding.sequence!.every((step, index) => step.toLowerCase() === candidate[index]),
      );
      if (exact) {
        event.preventDefault();
        clearChord();
        exact.run(event);
        return;
      }

      const prefix = sequences.some(
        (binding) =>
          binding.sequence!.length > candidate.length &&
          candidate.every((step, index) => binding.sequence![index]?.toLowerCase() === step),
      );
      if (prefix) {
        event.preventDefault();
        setChord(candidate);
        return;
      }

      if (pendingRef.current.length > 0) clearChord();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [disabled, clearChord, setChord]);

  useEffect(() => () => {
    if (chordTimer.current !== null) window.clearTimeout(chordTimer.current);
  }, []);

  const value = useMemo<ShortcutsContextValue>(
    () => ({ register, list, openHelp, closeHelp, helpOpen, version }),
    [register, list, openHelp, closeHelp, helpOpen, version],
  );

  return (
    <ShortcutsContext.Provider value={value}>
      <ProviderBindings
        navigate={navigate}
        openHelp={openHelp}
        closeHelp={closeHelp}
        clearChord={clearChord}
      />
      {children}
      <ChordHint keys={pending} />
      <ShortcutHelp open={helpOpen} onClose={closeHelp} />
    </ShortcutsContext.Provider>
  );
}

/**
 * The bindings the shortcut layer owns itself. Everything route-specific —
 * ⌘K for the palette, "/" for the search field — is claimed by the component
 * that owns that surface.
 */
function ProviderBindings({
  navigate,
  openHelp,
  closeHelp,
  clearChord,
}: {
  navigate: ReturnType<typeof useNavigate>;
  openHelp: () => void;
  closeHelp: () => void;
  clearChord: () => void;
}) {
  useShortcut({
    id: "nav.dashboard",
    label: "Go to Dashboard",
    group: "Navigation",
    keys: ["G", "then", "D"],
    sequence: ["g", "d"],
    run: () => navigate("/"),
  });

  useShortcut({
    id: "nav.projects",
    label: "Go to Projects",
    group: "Navigation",
    keys: ["G", "then", "P"],
    sequence: ["g", "p"],
    run: () => navigate("/projects"),
  });

  useShortcut({
    id: "help.open",
    label: "Keyboard shortcuts",
    group: "General",
    keys: ["?"],
    combo: { key: "?" },
    run: () => openHelp(),
  });

  useShortcut({
    id: "general.escape",
    label: "Close overlay or cancel a chord",
    group: "General",
    keys: ["Esc"],
    combo: { key: "Escape" },
    allowInInput: true,
    // Never swallow Escape: overlays own it first (they stop it in the capture
    // phase), and inside a field the browser default still belongs to the user.
    preventDefault: false,
    run: () => {
      clearChord();
      closeHelp();
    },
  });

  return null;
}

/* ==========================================================================
   Hooks
========================================================================== */

export function useShortcuts(): ShortcutsContextValue {
  const context = useContext(ShortcutsContext);
  if (context) return context;
  return NOOP_CONTEXT;
}

const NOOP_CONTEXT: ShortcutsContextValue = {
  register: () => () => undefined,
  list: () => [],
  openHelp: () => undefined,
  closeHelp: () => undefined,
  helpOpen: false,
  version: 0,
};

/**
 * Claim a binding for as long as the component is mounted. `run` may be a
 * fresh closure on every render — it is read through a ref, so the binding is
 * not re-registered and the handler is never stale.
 */
export function useShortcut(binding: ShortcutBinding): void {
  const { register } = useShortcuts();
  const runRef = useRef(binding.run);

  useEffect(() => {
    runRef.current = binding.run;
  });

  const {
    id,
    label,
    group,
    keys,
    combo,
    sequence,
    allowInInput,
    preventDefault,
    hidden,
  } = binding;

  const keysKey = keys.join("+");
  const comboKey = combo ? `${combo.key}|${combo.mod}|${combo.shift}|${combo.alt}` : "";
  const sequenceKey = sequence ? sequence.join(">") : "";

  useEffect(() => {
    const entry: ShortcutBinding = {
      id,
      label,
      group,
      keys: keysKey.length > 0 ? keysKey.split("+") : [],
      run: (event) => runRef.current(event),
      ...(combo ? { combo } : {}),
      ...(sequence ? { sequence } : {}),
      ...(allowInInput === undefined ? {} : { allowInInput }),
      ...(preventDefault === undefined ? {} : { preventDefault }),
      ...(hidden === undefined ? {} : { hidden }),
    };
    return register(entry);
    // `combo` / `sequence` are compared through their serialised keys.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    register,
    id,
    label,
    group,
    keysKey,
    comboKey,
    sequenceKey,
    allowInInput,
    preventDefault,
    hidden,
  ]);
}

/* ==========================================================================
   Chord hint
========================================================================== */

/** A quiet corner chip while a chord is half-typed, so "g" never feels dead. */
function ChordHint({ keys }: { keys: readonly string[] }) {
  if (keys.length === 0) return null;
  return (
    <div
      className={cx(
        "pointer-events-none fixed bottom-4 left-1/2 -translate-x-1/2",
        Z_CLASS.toast,
        "flex items-center gap-2 rounded-lg border border-border bg-surface-overlay px-3 py-2 shadow-e4",
        "animate-fade-in",
      )}
      role="status"
      aria-live="polite"
    >
      <Kbd keys={keys.map((key) => key.toUpperCase())} />
      <span className="text-meta text-content-subtle">waiting for the next key…</span>
    </div>
  );
}

/* ==========================================================================
   Help overlay
========================================================================== */

const GROUP_ORDER = ["General", "Navigation", "Search", "View"];

function ShortcutHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { list, version } = useShortcuts();

  const groups = useMemo(() => {
    const visible = list().filter((binding) => !binding.hidden);
    const map = new Map<string, ShortcutBinding[]>();
    for (const binding of visible) {
      const bucket = map.get(binding.group);
      if (bucket) bucket.push(binding);
      else map.set(binding.group, [binding]);
    }
    return [...map.entries()].sort((a, b) => {
      const rankA = GROUP_ORDER.indexOf(a[0]);
      const rankB = GROUP_ORDER.indexOf(b[0]);
      return (rankA === -1 ? 99 : rankA) - (rankB === -1 ? 99 : rankB);
    });
    // `version` is the registry's change signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, version, open]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Keyboard shortcuts"
      description="ConstructOS is built to be driven from the keyboard. None of these fire while you are typing."
      icon={IconKeyboard}
      size="lg"
    >
      <div className="grid gap-6 sm:grid-cols-2">
        {groups.map(([group, bindings]) => (
          <section key={group}>
            <h3 className="mb-2 text-label uppercase text-content-subtle">{group}</h3>
            <ul className="divide-y divide-border-subtle rounded-lg border border-border bg-surface-raised">
              {bindings.map((binding) => (
                <li
                  key={binding.id}
                  className="flex items-center justify-between gap-3 px-3 py-2"
                >
                  <span className="min-w-0 truncate text-body text-content">{binding.label}</span>
                  <ShortcutKeycaps keys={binding.keys} />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Modal>
  );
}

/** Renders "then" as plain text between two keycaps rather than as a key. */
function ShortcutKeycaps({ keys }: { keys: readonly string[] }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      {keys.map((key, index) =>
        key.toLowerCase() === "then" ? (
          <span key={`then-${index}`} className="text-meta text-content-subtle">
            then
          </span>
        ) : (
          <Kbd key={`${key}-${index}`}>{key}</Kbd>
        ),
      )}
    </span>
  );
}
