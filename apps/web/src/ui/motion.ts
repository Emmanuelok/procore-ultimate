/**
 * motion.ts — the app's shared animation vocabulary.
 *
 * Rules of the house:
 *   • Motion explains a spatial relationship or it does not ship.
 *   • Nothing animates for longer than 260ms except a full-height drawer.
 *   • Everything collapses to a no-op when the user asks for reduced motion.
 *
 * The app root renders <MotionConfig reducedMotion="user"> (see
 * src/lib/theme.tsx), so transform/layout animation is already suppressed for
 * those users globally. Use `useMotionVariants()` / `useVariants()` when you
 * additionally want opacity fades removed.
 */
import { useReducedMotion } from "framer-motion";
import type { BezierDefinition, Transition, Variants } from "framer-motion";

export {
  AnimatePresence,
  LayoutGroup,
  MotionConfig,
  motion,
  useReducedMotion,
} from "framer-motion";
export type { Transition, Variants } from "framer-motion";

/* ============================================================================
   Primitives — keep in lockstep with the --ds-duration-* / --ease-* CSS tokens
============================================================================ */

/** Seconds (framer's unit), mirroring --ds-duration-* in styles.css. */
export const DURATION = {
  instant: 0.06,
  fast: 0.11,
  base: 0.17,
  slow: 0.26,
  slower: 0.38,
} as const;

export type DurationName = keyof typeof DURATION;

export const EASE: Record<
  "standard" | "emphasized" | "decelerate" | "accelerate" | "overshoot",
  BezierDefinition
> = {
  /** Default for colour/opacity and most small moves. */
  standard: [0.2, 0, 0, 1],
  /** Entrances of surfaces that own the screen: drawers, sheets, modals. */
  emphasized: [0.32, 0.72, 0, 1],
  /** Things arriving. */
  decelerate: [0.05, 0.7, 0.1, 1],
  /** Things leaving. */
  accelerate: [0.3, 0, 0.8, 0.15],
  /** A single, restrained overshoot. Use for confirmations only. */
  overshoot: [0.34, 1.56, 0.64, 1],
};

export const SPRING = {
  /** Crisp; for popovers, chips, toggles. */
  snappy: { type: "spring", stiffness: 520, damping: 38, mass: 0.9 },
  /** Softer; for drawers and cards. */
  soft: { type: "spring", stiffness: 320, damping: 34, mass: 1 },
  /** Layout transitions between list/board views. */
  layout: { type: "spring", stiffness: 400, damping: 40, mass: 1 },
} as const satisfies Record<string, Transition>;

export const transition = {
  instant: { duration: DURATION.instant, ease: EASE.standard },
  fast: { duration: DURATION.fast, ease: EASE.standard },
  base: { duration: DURATION.base, ease: EASE.standard },
  slow: { duration: DURATION.slow, ease: EASE.emphasized },
  enter: { duration: DURATION.base, ease: EASE.decelerate },
  exit: { duration: DURATION.fast, ease: EASE.accelerate },
  spring: SPRING.snappy,
  springSoft: SPRING.soft,
  none: { duration: 0 },
} as const satisfies Record<string, Transition>;

/** Instant transition used everywhere motion is disabled. */
export const NO_TRANSITION: Transition = { duration: 0 };

/* ============================================================================
   Reduced motion
============================================================================ */

/** SSR-safe synchronous read. Prefer `useReducedMotion()` inside components. */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const MOTION_KEYS = [
  "x",
  "y",
  "z",
  "scale",
  "scaleX",
  "scaleY",
  "rotate",
  "rotateX",
  "rotateY",
  "rotateZ",
  "skew",
  "skewX",
  "skewY",
  "translateX",
  "translateY",
  "height",
  "width",
  "clipPath",
  "filter",
] as const;

/**
 * Strip every spatial property from a variant set and zero its transitions,
 * leaving a set that cross-fades instantly. Safe to call on any Variants.
 */
export function reduceVariants(variants: Variants): Variants {
  const out: Variants = {};
  for (const [state, value] of Object.entries(variants)) {
    if (typeof value !== "object" || value === null) {
      out[state] = value;
      continue;
    }
    const next: Record<string, unknown> = {};
    for (const [prop, propValue] of Object.entries(value as Record<string, unknown>)) {
      if ((MOTION_KEYS as readonly string[]).includes(prop)) continue;
      if (prop === "transition") continue;
      next[prop] = propValue;
    }
    next["transition"] = NO_TRANSITION;
    out[state] = next as Variants[string];
  }
  return out;
}

/** Returns `variants` untouched, or a flattened copy under reduced motion. */
export function useVariants(variants: Variants): Variants {
  const reduced = useReducedMotion();
  return reduced ? reduceVariants(variants) : variants;
}

/** Returns `value` normally, or `NO_TRANSITION` under reduced motion. */
export function useTransition(value: Transition = transition.base): Transition {
  const reduced = useReducedMotion();
  return reduced ? NO_TRANSITION : value;
}

/* ============================================================================
   Variants
   Every set uses the same state names: "hidden" | "visible" | "exit".
   Drive them with <motion.div variants={fade} initial="hidden"
   animate="visible" exit="exit" />.
============================================================================ */

/** Pure opacity. The default for anything that has no spatial origin. */
export const fade: Variants = {
  hidden: { opacity: 0, transition: transition.exit },
  visible: { opacity: 1, transition: transition.base },
  exit: { opacity: 0, transition: transition.exit },
};

/** Content arriving from below: page sections, cards, empty states. */
export const slideUp: Variants = {
  hidden: { opacity: 0, y: 8 },
  visible: { opacity: 1, y: 0, transition: transition.enter },
  exit: { opacity: 0, y: 4, transition: transition.exit },
};

/** Content arriving from above: banners, inline alerts. */
export const slideDown: Variants = {
  hidden: { opacity: 0, y: -8 },
  visible: { opacity: 1, y: 0, transition: transition.enter },
  exit: { opacity: 0, y: -4, transition: transition.exit },
};

/** Anchored surfaces: menus, popovers, tooltips, command palette. */
export const scaleIn: Variants = {
  hidden: { opacity: 0, scale: 0.96, y: -4 },
  visible: { opacity: 1, scale: 1, y: 0, transition: transition.spring },
  exit: { opacity: 0, scale: 0.98, y: -2, transition: transition.exit },
};

/** Parent of a list: staggers its children on entry, reverses on exit. */
export const listStagger: Variants = {
  hidden: { opacity: 1 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.028, delayChildren: 0.02 },
  },
  exit: {
    opacity: 1,
    transition: { staggerChildren: 0.012, staggerDirection: -1 },
  },
};

/** Child of `listStagger`. */
export const listItem: Variants = {
  hidden: { opacity: 0, y: 6 },
  visible: { opacity: 1, y: 0, transition: transition.enter },
  exit: { opacity: 0, y: -4, transition: transition.exit },
};

/** Right-hand drawer / inspector panel. */
export const drawerSlide: Variants = {
  hidden: { x: "100%", opacity: 1 },
  visible: {
    x: 0,
    opacity: 1,
    transition: { duration: DURATION.slow, ease: EASE.emphasized },
  },
  exit: {
    x: "100%",
    transition: { duration: DURATION.base, ease: EASE.accelerate },
  },
};

/** Left-hand drawer (mobile nav). */
export const drawerSlideLeft: Variants = {
  hidden: { x: "-100%" },
  visible: {
    x: 0,
    transition: { duration: DURATION.slow, ease: EASE.emphasized },
  },
  exit: {
    x: "-100%",
    transition: { duration: DURATION.base, ease: EASE.accelerate },
  },
};

/** Bottom sheet. */
export const sheetSlide: Variants = {
  hidden: { y: "100%" },
  visible: { y: 0, transition: { duration: DURATION.slow, ease: EASE.emphasized } },
  exit: { y: "100%", transition: { duration: DURATION.base, ease: EASE.accelerate } },
};

/** Modal backdrop. Pair with `modalPanel`. */
export const overlayFade: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: DURATION.fast } },
  exit: { opacity: 0, transition: { duration: DURATION.fast } },
};

/** Centred dialog panel. */
export const modalPanel: Variants = {
  hidden: { opacity: 0, scale: 0.97, y: 8 },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: { duration: DURATION.base, ease: EASE.emphasized },
  },
  exit: {
    opacity: 0,
    scale: 0.98,
    y: 4,
    transition: { duration: DURATION.fast, ease: EASE.accelerate },
  },
};

/** Toast entering from the bottom-right stack. */
export const toastSlide: Variants = {
  hidden: { opacity: 0, y: 12, scale: 0.98 },
  visible: { opacity: 1, y: 0, scale: 1, transition: transition.spring },
  exit: { opacity: 0, y: 8, scale: 0.98, transition: transition.exit },
};

/** Accordion / disclosure. Animate `height` with a measured child. */
export const collapse: Variants = {
  hidden: { height: 0, opacity: 0, transition: transition.exit },
  visible: {
    height: "auto",
    opacity: 1,
    transition: { duration: DURATION.base, ease: EASE.emphasized },
  },
  exit: { height: 0, opacity: 0, transition: transition.exit },
};

/** Route-level page transition. Deliberately almost imperceptible. */
export const pageTransition: Variants = {
  hidden: { opacity: 0, y: 4 },
  visible: { opacity: 1, y: 0, transition: { duration: DURATION.fast } },
  exit: { opacity: 0, transition: { duration: DURATION.instant } },
};

/* ============================================================================
   Bundle + hook
============================================================================ */

export const variants = {
  fade,
  slideUp,
  slideDown,
  scaleIn,
  listStagger,
  listItem,
  drawerSlide,
  drawerSlideLeft,
  sheetSlide,
  overlayFade,
  modalPanel,
  toastSlide,
  collapse,
  pageTransition,
} as const;

export type VariantName = keyof typeof variants;

export type MotionVariantSet = Record<VariantName, Variants>;

const REDUCED_VARIANTS: MotionVariantSet = Object.fromEntries(
  Object.entries(variants).map(([name, value]) => [name, reduceVariants(value)]),
) as MotionVariantSet;

/**
 * The whole vocabulary, already reduced if the user asked for it.
 *
 *   const m = useMotionVariants();
 *   <motion.div variants={m.slideUp} initial="hidden" animate="visible" />
 */
export function useMotionVariants(): MotionVariantSet {
  const reduced = useReducedMotion();
  return reduced ? REDUCED_VARIANTS : (variants as unknown as MotionVariantSet);
}

/** Common interaction feedback, ready to spread onto a motion component. */
export const press = {
  whileHover: { y: -1 },
  whileTap: { scale: 0.985 },
  transition: transition.fast,
} as const;

export const pressFlat = {
  whileTap: { scale: 0.98 },
  transition: transition.instant,
} as const;
