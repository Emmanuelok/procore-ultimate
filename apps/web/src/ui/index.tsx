/**
 * ../ui — the single import surface for every page in ConstructOS.
 *
 *     import { Button, Card, DataTable, Modal } from "../../ui";
 *
 * This file is a barrel and nothing else: no component is defined here. The
 * design system is split by concern and re-exported below.
 *
 *   ./primitives  buttons, inputs, badges, cards, tables, feedback, layout
 *   ./overlays    modal, dialog, drawer, sheet, popover, tooltip, toast
 *   ./inputs      rich entry: combobox, date, file, search, editors
 *   ./data        data table, list views, board, filters, pagination
 *   ./charts      recharts wrappers bound to the chart tokens
 *
 * Foundations are importable directly and are deliberately NOT star-exported
 * here — they carry short, collision-prone names (`tone`, `text`, `surface`,
 * `focus`) that do not belong in a barrel:
 *
 *   import { cx } from "../../ui/cx";
 *   import { tone, statusToTone, Z } from "../../ui/tokens";
 *   import { IconRfi, IconChevronDown } from "../../ui/icons";
 *   import { motion, useMotionVariants } from "../../ui/motion";
 *
 * ---------------------------------------------------------------------------
 * BACKWARD COMPATIBILITY CONTRACT
 *
 * ~89k lines across 35 page directories import from here. The 18 symbols this
 * module has always exported — Button, Input, Textarea, Select, Field, Card,
 * CardBody, PageHeader, Table, Th, Td, Badge, statusTone, EmptyState, Spinner,
 * Modal, ErrorAlert — keep their exact call signatures. Props have only ever
 * been *added* or *widened*; none was removed, renamed, or made required.
 *
 * Those names are re-exported EXPLICITLY (not via `export *`). An explicit
 * re-export takes precedence over a star export, so if a sibling module ever
 * exports a colliding name, the legacy symbol still resolves to exactly one
 * implementation instead of silently becoming ambiguous and disappearing.
 * ---------------------------------------------------------------------------
 */

/* ===========================================================================
   Module surfaces
   =========================================================================== */

export * from "./primitives";
export * from "./overlays";

/* ---------------------------------------------------------------------------
 * The rest of the library. These three landed after this barrel was first
 * written and are now wired. The pinned blocks further down still guarantee
 * the legacy names resolve to one implementation even where a module here
 * exports a colliding name.
 * ------------------------------------------------------------------------- */

export * from "./inputs";
export * from "./data";
// `ProgressRing` exists in both ./primitives (a compact inline indicator) and
// ./charts (the full radial chart). The primitive owns the plain name because
// existing pages reference it; the chart version is exported by ./charts as
// ChartProgressRing.
export * from "./charts";

/* ===========================================================================
   Pinned resolutions

   Names that exist in more than one module. Listing them here picks the
   owner deterministically instead of leaving an ambiguous star export.
   =========================================================================== */

/** Overlays owns every portalled surface, including the legacy `Modal`. */
export { Modal } from "./overlays";
export type { ModalProps } from "./overlays";

/** Primitives owns the broader `IconLike` (also accepts plain nodes/strings). */
export type { IconLike } from "./primitives";

/* ===========================================================================
   Legacy contract — pinned so it can never become ambiguous.
   Do not remove an entry from this block.
   =========================================================================== */

export {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  ErrorAlert,
  Field,
  Input,
  PageHeader,
  Select,
  Spinner,
  Table,
  Td,
  Textarea,
  Th,
  statusTone,
} from "./primitives";

export type {
  BadgeProps,
  ButtonProps,
  CardBodyProps,
  CardProps,
  EmptyStateProps,
  ErrorAlertProps,
  FieldProps,
  InputProps,
  PageHeaderProps,
  SelectProps,
  SpinnerProps,
  TableProps,
  TdProps,
  TextareaProps,
  ThProps,
} from "./primitives";

/* ===========================================================================
   Convenience re-exports

   The handful of foundation symbols worth having on the barrel because pages
   reach for them constantly. Everything else stays behind its own module.
   =========================================================================== */

export { cx, cn } from "./cx";
export type { ClassValue } from "./cx";

export {
  TONES,
  TONE_LABEL,
  toneClass,
  statusToTone,
  statusToLegacyTone,
  formatStatusLabel,
  normalizeKey,
  fromLegacyBadgeTone,
  toLegacyBadgeTone,
  SEVERITIES,
  SEVERITY_LABEL,
  SEVERITY_RANK,
  asSeverity,
  severityToTone,
  STAGES,
  STAGE_LABEL,
  STAGE_ORDER,
  asStage,
  stageToTone,
  PRIORITIES,
  PRIORITY_LABEL,
  PRIORITY_RANK,
  asPriority,
  priorityToTone,
  RAG_STATES,
  RAG_LABEL,
  asRag,
  ragToTone,
  directionOf,
  deltaToTone,
  cssVar,
  chartColor,
  CHART_COLORS,
  readToken,
  Z,
  Z_CLASS,
} from "./tokens";

export type {
  Density,
  Direction,
  LegacyBadgeTone,
  Priority,
  RagState,
  ResolvedTheme,
  Severity,
  Stage,
  ThemePreference,
  Tone,
  ZLayer,
} from "./tokens";
