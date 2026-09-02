/**
 * theme.tsx — theme + density control for the whole app.
 *
 * Two independent axes:
 *   theme    "light" | "dark" | "system"     → data-theme="light|dark" on <html>
 *   density  "comfortable" | "compact"       → data-density on <html>
 *
 * Both are persisted to localStorage and re-applied by the inline script in
 * index.html *before first paint*, so there is never a flash of the wrong
 * theme. Anything rendered here must therefore agree with that script — the
 * storage keys and attribute names live in src/ui/tokens.ts and are shared.
 *
 * Usage:
 *   <ThemeProvider><App /></ThemeProvider>
 *   const { resolvedTheme, setTheme, density, setDensity } = useTheme();
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
import { MotionConfig } from "framer-motion";
import {
  DENSITIES,
  DENSITY_STORAGE_KEY,
  THEMES,
  THEME_COLOR,
  THEME_STORAGE_KEY,
  type Density,
  type ResolvedTheme,
  type ThemePreference,
} from "../ui/tokens";

export type { Density, ResolvedTheme, ThemePreference };
export { DENSITIES, THEMES, THEME_STORAGE_KEY, DENSITY_STORAGE_KEY };

const DARK_QUERY = "(prefers-color-scheme: dark)";

/* ============================================================================
   DOM plumbing (works with or without React)
============================================================================ */

function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

function isDensity(value: unknown): value is Density {
  return typeof value === "string" && (DENSITIES as readonly string[]).includes(value);
}

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode / storage disabled — the DOM attribute still applies */
  }
}

/** The OS preference right now. Defaults to light when unknown. */
export function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "light";
  }
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === "system" ? getSystemTheme() : preference;
}

/**
 * Suppress the global colour transition for one frame so flipping the theme
 * is instantaneous rather than a slow, muddy cross-fade of the entire page.
 */
function withoutTransitions(apply: () => void): void {
  if (typeof document === "undefined") {
    apply();
    return;
  }
  const style = document.createElement("style");
  style.appendChild(
    document.createTextNode(
      "*,*::before,*::after{transition:none!important;animation-duration:0s!important}",
    ),
  );
  document.head.appendChild(style);
  apply();
  // Force a style recalculation before releasing the override.
  window.getComputedStyle(document.body).opacity;
  window.requestAnimationFrame(() => {
    style.remove();
  });
}

/** Write the resolved theme to <html> and the browser chrome colour. */
export function applyTheme(resolved: ResolvedTheme, animate = false): void {
  if (typeof document === "undefined") return;
  const write = (): void => {
    const root = document.documentElement;
    root.setAttribute("data-theme", resolved);
    root.style.colorScheme = resolved;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", THEME_COLOR[resolved]);
  };
  if (animate) write();
  else withoutTransitions(write);
}

export function applyDensity(density: Density): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-density", density);
}

/** Read the persisted preference (or the provided default). */
export function getStoredTheme(fallback: ThemePreference = "system"): ThemePreference {
  if (typeof window === "undefined") return fallback;
  const raw = readStorage(THEME_STORAGE_KEY);
  return isThemePreference(raw) ? raw : fallback;
}

export function getStoredDensity(fallback: Density = "comfortable"): Density {
  if (typeof window === "undefined") return fallback;
  const raw = readStorage(DENSITY_STORAGE_KEY);
  return isDensity(raw) ? raw : fallback;
}

/* ============================================================================
   Context
============================================================================ */

export interface ThemeContextValue {
  /** What the user chose — may be "system". */
  theme: ThemePreference;
  /** What is actually on screen — never "system". */
  resolvedTheme: ResolvedTheme;
  /** The OS preference, regardless of `theme`. */
  systemTheme: ResolvedTheme;
  /** Convenience for `resolvedTheme === "dark"`. */
  isDark: boolean;
  density: Density;
  setTheme: (theme: ThemePreference) => void;
  setDensity: (density: Density) => void;
  /** light → dark → light. Never lands on "system". */
  toggleTheme: () => void;
  /** comfortable ⇄ compact. */
  toggleDensity: () => void;
  /** Steps light → dark → system → light. For a three-state control. */
  cycleTheme: () => void;
}

/**
 * Detached fallback. If a subtree renders outside <ThemeProvider>, theme
 * switching still works (it is attribute-driven CSS) — only React re-renders
 * are missed. Better than crashing 35 page directories.
 */
function createDetachedValue(): ThemeContextValue {
  const theme = getStoredTheme();
  const system = getSystemTheme();
  const resolved = resolveTheme(theme);
  const density = getStoredDensity();
  return {
    theme,
    resolvedTheme: resolved,
    systemTheme: system,
    isDark: resolved === "dark",
    density,
    setTheme: (next) => {
      writeStorage(THEME_STORAGE_KEY, next);
      applyTheme(resolveTheme(next));
    },
    setDensity: (next) => {
      writeStorage(DENSITY_STORAGE_KEY, next);
      applyDensity(next);
    },
    toggleTheme: () => {
      const next: ThemePreference = resolved === "dark" ? "light" : "dark";
      writeStorage(THEME_STORAGE_KEY, next);
      applyTheme(next);
    },
    toggleDensity: () => {
      const next: Density = density === "compact" ? "comfortable" : "compact";
      writeStorage(DENSITY_STORAGE_KEY, next);
      applyDensity(next);
    },
    cycleTheme: () => {
      const order: ThemePreference[] = ["light", "dark", "system"];
      const index = order.indexOf(theme);
      const next = order[(index + 1) % order.length] ?? "system";
      writeStorage(THEME_STORAGE_KEY, next);
      applyTheme(resolveTheme(next));
    },
  };
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export interface ThemeProviderProps {
  children: ReactNode;
  /** Used only when nothing is persisted yet. */
  defaultTheme?: ThemePreference;
  defaultDensity?: Density;
  /** Set false to keep the page-wide colour cross-fade when switching. */
  disableTransitionOnChange?: boolean;
  /**
   * Wrap children in framer-motion's <MotionConfig reducedMotion="user"> so
   * every animation in the app honours the OS setting. Default true.
   */
  respectReducedMotion?: boolean;
}

export function ThemeProvider({
  children,
  defaultTheme = "system",
  defaultDensity = "comfortable",
  disableTransitionOnChange = true,
  respectReducedMotion = true,
}: ThemeProviderProps) {
  const [theme, setThemeState] = useState<ThemePreference>(() =>
    getStoredTheme(defaultTheme),
  );
  const [density, setDensityState] = useState<Density>(() =>
    getStoredDensity(defaultDensity),
  );
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(getSystemTheme);
  const firstRun = useRef(true);

  const resolvedTheme: ResolvedTheme = theme === "system" ? systemTheme : theme;

  /* Track the OS preference. */
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const media = window.matchMedia(DARK_QUERY);
    const onChange = (event: MediaQueryListEvent): void => {
      setSystemTheme(event.matches ? "dark" : "light");
    };
    media.addEventListener("change", onChange);
    setSystemTheme(media.matches ? "dark" : "light");
    return () => media.removeEventListener("change", onChange);
  }, []);

  /* Reflect resolved theme onto <html>. */
  useEffect(() => {
    const animate = !disableTransitionOnChange && !firstRun.current;
    applyTheme(resolvedTheme, animate);
    firstRun.current = false;
  }, [resolvedTheme, disableTransitionOnChange]);

  /* Reflect density onto <html>. */
  useEffect(() => {
    applyDensity(density);
  }, [density]);

  /* Keep tabs in sync. */
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onStorage = (event: StorageEvent): void => {
      if (event.key === THEME_STORAGE_KEY && isThemePreference(event.newValue)) {
        setThemeState(event.newValue);
      }
      if (event.key === DENSITY_STORAGE_KEY && isDensity(event.newValue)) {
        setDensityState(event.newValue);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setTheme = useCallback((next: ThemePreference) => {
    writeStorage(THEME_STORAGE_KEY, next);
    setThemeState(next);
  }, []);

  const setDensity = useCallback((next: Density) => {
    writeStorage(DENSITY_STORAGE_KEY, next);
    setDensityState(next);
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(resolvedTheme === "dark" ? "light" : "dark");
  }, [resolvedTheme, setTheme]);

  const toggleDensity = useCallback(() => {
    setDensity(density === "compact" ? "comfortable" : "compact");
  }, [density, setDensity]);

  const cycleTheme = useCallback(() => {
    const order: ThemePreference[] = ["light", "dark", "system"];
    const index = order.indexOf(theme);
    setTheme(order[(index + 1) % order.length] ?? "system");
  }, [theme, setTheme]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      resolvedTheme,
      systemTheme,
      isDark: resolvedTheme === "dark",
      density,
      setTheme,
      setDensity,
      toggleTheme,
      toggleDensity,
      cycleTheme,
    }),
    [
      theme,
      resolvedTheme,
      systemTheme,
      density,
      setTheme,
      setDensity,
      toggleTheme,
      toggleDensity,
      cycleTheme,
    ],
  );

  if (!respectReducedMotion) {
    return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
  }

  return (
    <ThemeContext.Provider value={value}>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </ThemeContext.Provider>
  );
}

let warned = false;

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (context) return context;
  if (import.meta.env.DEV && !warned) {
    warned = true;
    // eslint-disable-next-line no-console
    console.warn(
      "[theme] useTheme() called outside <ThemeProvider>. Theme switching " +
        "still works, but components will not re-render on change. Wrap the " +
        "app root in <ThemeProvider>.",
    );
  }
  return createDetachedValue();
}

/** Read-only helper for components that only need to branch on dark/light. */
export function useResolvedTheme(): ResolvedTheme {
  return useTheme().resolvedTheme;
}

export default ThemeProvider;
