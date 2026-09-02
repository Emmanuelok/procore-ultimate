/**
 * Shared machinery for the QUALITY workspace.
 *
 * THE HOUSE RULES, IMPLEMENTED ONCE HERE SO EVERY PANEL OBEYS THEM
 *
 *  1. A figure the API returned as `{ value: null, reasons: [...] }` renders
 *     as "not available" WITH the server's reasons printed verbatim. Never a
 *     zero: a first-time-pass rate of 0% over no checklists reads as a crisis
 *     and a rate of 100% reads as success, and neither is true.
 *  2. A refusal is rendered in the server's own words. The quality API writes
 *     long, specific sentences — which hold point, which nominated party,
 *     which artefacts are missing — and paraphrasing them destroys the only
 *     thing that makes them actionable.
 *  3. A SEGREGATION refusal is framed as the control working, not as an
 *     error. An NCR whose `use_as_is` was approved by the person who proposed
 *     it is exactly what this register exists to prevent; when the platform
 *     stops it, that is the product doing its job.
 *  4. Money carries its currency and is never summed across currencies.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Alert, Badge, Button, EmptyState, Field, Modal, Textarea } from "../../ui";
import { formatCurrency, formatNumber } from "../../ui/data";
import { cx } from "../../ui/cx";
import { IconQuality, IconRefresh } from "../../ui/icons";
import { toneClass, type Tone } from "../../ui/tokens";
import { ApiClientError, api } from "../../lib/api";
import type { ChecklistTemplateItem, Figure } from "./types";

export const EM_DASH = "—";

/* ================================================================== */
/* Formatting                                                          */
/* ================================================================== */

/** snake_case → Sentence case. The API's vocabulary is snake_case throughout. */
export function labelize(value: string | null | undefined): string {
  if (!value) return EM_DASH;
  const spaced = value.replace(/[_\s]+/g, " ").trim();
  if (spaced === "") return EM_DASH;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function isoDate(value: string | null | undefined): string {
  return value && value.length >= 10 ? value.slice(0, 10) : EM_DASH;
}

export function dateTime(value: string | null | undefined): string {
  if (!value) return EM_DASH;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function num(value: number | null | undefined, precision = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  return formatNumber(value, { precision });
}

export function pct(value: number | null | undefined, precision = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  return `${formatNumber(value, { precision })}%`;
}

/** Money always names its currency; there is no "the" currency on a project. */
export function money(value: number | null | undefined, currency: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  return formatCurrency(value, { currency, precision: 2 });
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Whole days between an ISO date and today. Negative = in the past. */
export function daysFromToday(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const then = Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(then)) return null;
  const now = Date.parse(`${todayIso()}T00:00:00Z`);
  return Math.round((then - now) / 86_400_000);
}

/* ================================================================== */
/* Vocabulary and tones                                                */
/* ================================================================== */

export const ITP_STATUS_TONE: Record<string, Tone> = {
  draft: "neutral",
  submitted: "info",
  approved: "success",
  approved_as_noted: "success",
  rejected: "danger",
  active: "accent",
  superseded: "neutral",
  closed: "neutral",
};

export const ACTIVITY_STATUS_TONE: Record<string, Tone> = {
  pending: "warning",
  notified: "info",
  released: "success",
  waived: "highlight",
  failed: "danger",
  closed: "neutral",
  not_applicable: "neutral",
};

export const INTERVENTION_TONE: Record<string, Tone> = {
  hold_point: "danger",
  witness_point: "warning",
  review_point: "info",
  notification_point: "info",
  surveillance_point: "neutral",
};

export const INTERVENTION_LABEL: Record<string, string> = {
  hold_point: "Hold point",
  witness_point: "Witness point",
  review_point: "Review point",
  notification_point: "Notification point",
  surveillance_point: "Surveillance",
};

/** What each intervention point actually does to the work in front of it. */
export const INTERVENTION_MEANING: Record<string, string> = {
  hold_point:
    "Work may not proceed past this point until the nominated party releases it. Proceeding anyway is a breach, and once the work is covered up it is a covering-up allegation.",
  witness_point:
    "The nominated party is invited. If they do not attend within the notice period the work may continue — which is why the notice, not the attendance, is the fact that matters.",
  review_point: "A document or a submission is reviewed. The work is not held at the face.",
  notification_point: "The party is told. Nothing is held and nothing is released.",
  surveillance_point:
    "Continuous monitoring. Nobody is summoned to it, so there is no notice to serve and nothing to release.",
};

export const RESPONSIBLE_PARTIES = [
  "contractor",
  "subcontractor",
  "engineer",
  "client",
  "third_party",
  "manufacturer",
  "regulator",
  "certifying_authority",
] as const;

export const INTERVENTION_POINTS = [
  "hold_point",
  "witness_point",
  "surveillance_point",
  "review_point",
  "notification_point",
] as const;

export const ACTIVITY_STATUSES = [
  "pending",
  "notified",
  "released",
  "waived",
  "failed",
  "closed",
  "not_applicable",
] as const;

export const CHECKLIST_STATUS_TONE: Record<string, Tone> = {
  draft: "neutral",
  scheduled: "info",
  in_progress: "accent",
  complete: "info",
  failed: "danger",
  reviewed: "success",
  closed: "neutral",
  void: "neutral",
};

export const RESULT_TONE: Record<string, Tone> = {
  pass: "success",
  pass_with_observations: "warning",
  fail: "danger",
  not_applicable: "neutral",
};

export const NCR_STATUS_TONE: Record<string, Tone> = {
  open: "danger",
  under_review: "warning",
  disposition_proposed: "warning",
  disposition_approved: "info",
  action_in_progress: "accent",
  verification_pending: "info",
  closed: "success",
  rejected: "neutral",
  void: "neutral",
};

export const NCR_SEVERITY_TONE: Record<string, Tone> = {
  minor: "info",
  major: "warning",
  critical: "danger",
};

export const DISPOSITION_TONE: Record<string, Tone> = {
  pending: "neutral",
  rework: "info",
  repair: "warning",
  use_as_is: "danger",
  reject: "danger",
  return_to_supplier: "warning",
  regrade: "warning",
};

/** The two that leave the departure permanently in the building. */
export const CONCESSION_DISPOSITIONS = ["use_as_is", "repair"];

export const DISPOSITION_MEANING: Record<string, string> = {
  rework: "The work is redone to the specification. Nothing non-conforming remains.",
  repair:
    "The work is made serviceable but not brought back to specification. A departure stays in the building, so the designer's concession is the only thing that makes it acceptable.",
  use_as_is:
    "The non-conforming work is accepted exactly as built. This is the disposition the whole register exists to make difficult: it can only be approved by someone other than its proposer, and only on a recorded concession.",
  reject: "The work is not accepted at all and is removed.",
  return_to_supplier: "The material goes back. The supplier carries the consequence.",
  regrade: "The item is accepted for a lesser duty than the one it was supplied for.",
};

export const NCR_OPEN_STATUSES = [
  "open",
  "under_review",
  "disposition_proposed",
  "disposition_approved",
  "action_in_progress",
  "verification_pending",
];

export const CX_STATUS_TONE: Record<string, Tone> = {
  not_started: "neutral",
  construction_complete: "info",
  prefunctional_in_progress: "accent",
  prefunctional_complete: "info",
  energised: "accent",
  functional_in_progress: "accent",
  functional_complete: "success",
  seasonal_pending: "warning",
  accepted: "success",
  turned_over: "success",
  on_hold: "danger",
};

/** The ladder in order, `on_hold` excluded — it is a state, not a rung. */
export const CX_LADDER = [
  "not_started",
  "construction_complete",
  "prefunctional_in_progress",
  "prefunctional_complete",
  "energised",
  "functional_in_progress",
  "functional_complete",
  "seasonal_pending",
  "accepted",
  "turned_over",
];

export const TEST_STATUS_TONE: Record<string, Tone> = {
  scheduled: "neutral",
  in_progress: "accent",
  complete: "info",
  failed: "danger",
  retest_required: "warning",
  accepted: "success",
  void: "neutral",
};

export const TEST_RESULT_TONE: Record<string, Tone> = {
  pass: "success",
  pass_with_deficiencies: "warning",
  fail: "danger",
  aborted: "danger",
  not_applicable: "neutral",
};

export const TURNOVER_STATUS_TONE: Record<string, Tone> = {
  draft: "neutral",
  assembling: "info",
  submitted: "accent",
  under_review: "accent",
  comments_issued: "warning",
  resubmitted: "accent",
  accepted: "success",
  rejected: "danger",
  handed_over: "success",
};

export const TURNOVER_ARTEFACT_KINDS = [
  "as_built_drawings",
  "o_and_m_manual",
  "test_records",
  "commissioning_certificates",
  "statutory_certificates",
  "warranties",
  "spare_parts_list",
  "training_records",
  "asset_register",
  "cobie_export",
  "software_licences",
  "keys_and_access",
  "punch_list_closeout",
  "operating_permits",
] as const;

export const ARTEFACT_LABEL: Record<string, string> = {
  as_built_drawings: "As-built drawings",
  o_and_m_manual: "O&M manual",
  test_records: "Test records",
  commissioning_certificates: "Commissioning certificates",
  statutory_certificates: "Statutory certificates",
  warranties: "Warranties",
  spare_parts_list: "Spare parts list",
  training_records: "Training records",
  asset_register: "Asset register",
  cobie_export: "COBie export",
  software_licences: "Software licences",
  keys_and_access: "Keys and access",
  punch_list_closeout: "Punch list closeout",
  operating_permits: "Operating permits",
};

export function artefactLabel(kind: string): string {
  return ARTEFACT_LABEL[kind] ?? labelize(kind);
}

/**
 * A left-edge status rail, as a `border-l-<colour>` utility.
 *
 * Deliberately NOT `toneClass(t, "border")`: that sets the colour of every
 * edge and would fight the card's own `border-border` with equal specificity,
 * so which one won would depend on stylesheet order. A side-specific utility
 * has nothing to fight.
 */
export const TONE_RAIL: Record<Tone, string> = {
  neutral: "border-l-neutral-border",
  accent: "border-l-accent",
  info: "border-l-info-solid",
  success: "border-l-success-solid",
  warning: "border-l-warning-solid",
  danger: "border-l-danger-solid",
  highlight: "border-l-highlight-solid",
};

export const STRICTNESS_MEANING: Record<string, string> = {
  block: "Submission and acceptance are refused while anything is outstanding.",
  warn: "Submission and acceptance are allowed, but every outstanding record is returned so the acceptance is demonstrably informed.",
  ignore: "Nothing is blocked. The gap is still reported — it is never hidden.",
};

/* ================================================================== */
/* Loading and mutation                                                */
/* ================================================================== */

export interface Resource<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiClientError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

/**
 * One loader for the whole workspace. A failed load is never rendered as an
 * empty register: "nothing here" and "we could not ask" are different
 * statements about a project's quality record, and only one of them is good
 * news.
 */
export function useResource<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
  enabled = true,
): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [nonce, setNonce] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (!enabled) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    setError(null);
    loadRef.current(controller.signal).then(
      (next) => {
        if (cancelled) return;
        setData(next);
        setLoading(false);
      },
      (err: unknown) => {
        if (cancelled || controller.signal.aborted) return;
        setError(errorMessage(err, "This view could not be loaded."));
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, loading, error, reload };
}

/** Company user directory, for turning actor ids into names. */
export function useCompanyUsers(): Map<string, string> {
  const [byId, setById] = useState<Map<string, string>>(() => new Map());
  useEffect(() => {
    let cancelled = false;
    api
      .get<{ items: Array<{ id: string; name: string; email: string }> }>(
        "/api/v1/company/users?page=1&pageSize=200",
      )
      .then((res) => {
        if (cancelled) return;
        setById(new Map(res.items.map((u) => [u.id, u.name || u.email])));
      })
      .catch(() => {
        /* names are a courtesy — ids still render, and an id is still evidence */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return byId;
}

/** Actor id → name, falling back to the id so an attribution is never blank. */
export function nameOf(users: Map<string, string>, id: string | null | undefined): string {
  if (!id) return EM_DASH;
  return users.get(id) ?? id;
}

/* ================================================================== */
/* Refusals, rendered verbatim                                         */
/* ================================================================== */

export interface Refusal {
  status: number;
  message: string;
  /** the refusal is a segregation-of-duties control, not a fault */
  segregation: boolean;
  /** the refusal is an authorisation decision (wrong party / self-release) */
  authorisation: boolean;
  extra: Array<{ key: string; value: string }>;
}

const SEGREGATION_MARKERS = [
  "must be done by someone other than the person who",
  "a second pair of eyes",
  "cannot also release it",
];

const AUTHORISATION_MARKERS = [
  "reserved to the nominated verifying party",
  "cannot also release it",
];

function stringifyDetail(value: unknown): string {
  if (value === null || value === undefined) return EM_DASH;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

export function refusalFrom(err: unknown): Refusal {
  const message = errorMessage(err, "The request was refused.");
  const status = err instanceof ApiClientError ? err.status : 0;
  const lower = message.toLowerCase();
  const body = err instanceof ApiClientError ? (err.details as { details?: unknown }) : undefined;
  const detail =
    body && typeof body === "object" && body.details && typeof body.details === "object"
      ? (body.details as Record<string, unknown>)
      : {};
  return {
    status,
    message,
    segregation: SEGREGATION_MARKERS.some((m) => lower.includes(m)),
    authorisation: status === 403 || AUTHORISATION_MARKERS.some((m) => lower.includes(m)),
    extra: Object.entries(detail).map(([key, value]) => ({
      key,
      value: stringifyDetail(value),
    })),
  };
}

/**
 * The refusal panel.
 *
 * A segregation refusal is deliberately NOT dressed as an error. Somebody
 * tried to approve their own disposition, or release their own hold point,
 * and the platform stopped them — that is the single control this whole
 * module is built around, and it is reported as having worked.
 */
export function RefusalNotice({
  refusal,
  onDismiss,
  className,
}: {
  refusal: Refusal | null;
  onDismiss?: () => void;
  className?: string;
}) {
  if (!refusal) return null;
  const heading = refusal.segregation
    ? "Segregation of duties — this control did its job"
    : refusal.authorisation
      ? "Refused: this decision is not yours to make"
      : "The server refused this";
  return (
    <Alert
      tone={refusal.segregation ? "warning" : "danger"}
      title={heading}
      className={cx("mb-3", className)}
      {...(onDismiss ? { onDismiss } : {})}
    >
      <p className="whitespace-pre-wrap">{refusal.message}</p>
      {refusal.segregation ? (
        <p className="mt-2 text-meta text-content-muted">
          Nothing has gone wrong. A record approved by the person who created it is a decision
          nobody independent ever made — this refusal is the difference between a quality system
          and a filing cabinet. Hand the step to the second party.
        </p>
      ) : null}
      {refusal.status ? (
        <p className="mt-1 text-2xs text-content-subtle">HTTP {refusal.status}</p>
      ) : null}
      {refusal.extra.length > 0 ? (
        <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-meta">
          {refusal.extra.map((e) => (
            <div key={e.key} className="contents">
              <dt className="font-medium">{e.key}</dt>
              <dd className="font-mono tabular-nums">{e.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </Alert>
  );
}

/** A mutation with its refusal held beside it, never swallowed. */
export function useAction(): {
  busy: string | null;
  refusal: Refusal | null;
  clear: () => void;
  run: <T>(key: string, fn: () => Promise<T>) => Promise<T | null>;
} {
  const [busy, setBusy] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const run = useCallback(async <T,>(key: string, fn: () => Promise<T>): Promise<T | null> => {
    setBusy(key);
    setRefusal(null);
    try {
      return await fn();
    } catch (err) {
      setRefusal(refusalFrom(err));
      return null;
    } finally {
      setBusy(null);
    }
  }, []);
  const clear = useCallback(() => setRefusal(null), []);
  return { busy, refusal, clear, run };
}

/* ================================================================== */
/* Honest figures                                                      */
/* ================================================================== */

/** Reasons printed exactly as the server wrote them. */
export function ReasonList({
  reasons,
  className,
}: {
  reasons: readonly string[];
  className?: string;
}) {
  if (reasons.length === 0) return null;
  return (
    <ul className={cx("space-y-1 text-2xs leading-snug text-content-subtle", className)}>
      {reasons.map((reason, i) => (
        <li key={i} className="flex gap-1.5">
          <span aria-hidden className="text-content-disabled">
            ·
          </span>
          <span className="whitespace-pre-wrap">{reason}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * A `Figure`. `value: null` becomes "not available" plus the server's reasons —
 * printed, not swallowed — because a zero here would read like an answer.
 */
export function FigureText({
  figure,
  render,
  className,
  hideReasons,
}: {
  figure: Figure | null | undefined;
  render: (value: number) => ReactNode;
  className?: string;
  hideReasons?: boolean;
}) {
  if (!figure) return <span className={className}>{EM_DASH}</span>;
  if (figure.value === null) {
    return (
      <span className={className}>
        <span className="italic text-content-subtle">not available</span>
        {!hideReasons ? <ReasonList reasons={figure.reasons} className="mt-1" /> : null}
      </span>
    );
  }
  return (
    <span className={className}>
      {render(figure.value)}
      {!hideReasons && figure.reasons.length > 0 ? (
        <ReasonList reasons={figure.reasons} className="mt-1" />
      ) : null}
    </span>
  );
}

/**
 * A headline figure in a tile. Never a bare number with no provenance: where
 * the value is null the tile says so and carries the reason underneath.
 */
export function FigureTile({
  label,
  figure,
  render,
  hint,
  tone,
}: {
  label: string;
  figure: Figure | null | undefined;
  render: (value: number) => string;
  hint?: ReactNode;
  tone?: Tone;
}) {
  const unknown = !figure || figure.value === null;
  return (
    <div className="rounded-lg border border-border bg-surface-raised p-3">
      <div className="text-label uppercase tracking-wide text-content-subtle">{label}</div>
      <div
        className={cx(
          "mt-1",
          unknown
            ? "text-sm italic text-content-subtle"
            : cx("text-xl font-semibold tabular-nums", tone ? toneClass(tone, "text") : "text-content"),
        )}
      >
        {unknown ? "not available" : render(figure!.value!)}
      </div>
      {hint ? <div className="mt-1 text-2xs text-content-subtle">{hint}</div> : null}
      {figure && figure.reasons.length > 0 ? (
        <ReasonList reasons={figure.reasons} className="mt-1.5" />
      ) : null}
    </div>
  );
}

/** A plain counted stat. Used only where the count IS the record count. */
export function CountTile({
  label,
  value,
  tone,
  hint,
  emphasis,
}: {
  label: string;
  value: number;
  tone?: Tone;
  hint?: ReactNode;
  emphasis?: boolean;
}) {
  return (
    <div
      className={cx(
        "rounded-lg border p-3",
        emphasis && value > 0 && tone
          ? cx(toneClass(tone, "subtle"), toneClass(tone, "border"))
          : "border-border bg-surface-raised",
      )}
    >
      <div className="text-label uppercase tracking-wide text-content-subtle">{label}</div>
      <div
        className={cx(
          "mt-1 text-xl font-semibold tabular-nums",
          tone && value > 0 ? toneClass(tone, "text") : "text-content",
        )}
      >
        {formatNumber(value, { precision: 0 })}
      </div>
      {hint ? <div className="mt-1 text-2xs text-content-subtle">{hint}</div> : null}
    </div>
  );
}

/** The standard load failure, with a retry. */
export function LoadError({
  message,
  onRetry,
  title,
}: {
  message: string;
  onRetry: () => void;
  title?: string;
}) {
  return (
    <Alert
      tone="danger"
      title={title ?? "This register could not be loaded"}
      actions={
        <Button size="sm" variant="secondary" icon={IconRefresh} onClick={onRetry}>
          Try again
        </Button>
      }
    >
      <p className="whitespace-pre-wrap">{message}</p>
      <p className="mt-1 text-meta text-content-muted">
        Nothing is being shown as empty in the meantime — an unread register and an empty one are
        different facts.
      </p>
    </Alert>
  );
}

/** A designed empty state that states the reason, never a bare zero. */
export function NothingHere({
  title,
  reason,
  action,
}: {
  title: string;
  reason: ReactNode;
  action?: ReactNode;
}) {
  return (
    <EmptyState
      icon={IconQuality}
      title={title}
      hint={reason}
      {...(action ? { action } : {})}
      size="md"
    />
  );
}

/* ================================================================== */
/* Tolerance arithmetic — mirrored, not invented                       */
/* ================================================================== */

/**
 * Comparison slack, matching TOLERANCE_EPSILON in the API's scoring engine.
 * A reading of 0.1 + 0.2 must not fail an upper bound of 0.3 because IEEE-754
 * says 0.30000000000000004.
 */
const TOLERANCE_EPSILON = 1e-9;

export interface ItemSpec {
  id: string;
  itemNumber: string | null;
  text: string;
  itemType: string;
  required: boolean;
  options: string[];
  targetValue: number | null;
  minValue: number | null;
  maxValue: number | null;
  tolerancePlus: number | null;
  toleranceMinus: number | null;
  unit: string | null;
  acceptanceCriteria: string | null;
  guidance: string | null;
  specReference: string | null;
  weight: number;
  isCritical: boolean;
  isHoldPoint: boolean;
  photoRequired: boolean;
  raisesNcrOnFail: boolean;
  section: string | null;
}

export interface ToleranceBounds {
  lower: number | null;
  upper: number | null;
  reasons: string[];
}

/**
 * The acceptance window of a numeric item, computed exactly as the API's
 * `toleranceBounds` does: BOTH a min/max pair and a target ± tolerance bind
 * when both are present, and where they disagree the TIGHTER wins. Letting one
 * silently widen the other is how a specified ±2mm becomes an accepted ±5mm.
 *
 * This is display arithmetic over stored columns, not a judgement — the
 * pass/fail verdict always comes from the server's own evaluation.
 */
export function toleranceBounds(item: {
  targetValue: number | null;
  minValue: number | null;
  maxValue: number | null;
  tolerancePlus: number | null;
  toleranceMinus: number | null;
}): ToleranceBounds {
  const reasons: string[] = [];
  const fromToleranceLower =
    item.targetValue !== null && item.toleranceMinus !== null
      ? item.targetValue - Math.abs(item.toleranceMinus)
      : null;
  const fromToleranceUpper =
    item.targetValue !== null && item.tolerancePlus !== null
      ? item.targetValue + Math.abs(item.tolerancePlus)
      : null;
  const lowers = [item.minValue, fromToleranceLower].filter((v): v is number => v !== null);
  const uppers = [item.maxValue, fromToleranceUpper].filter((v): v is number => v !== null);
  const lower = lowers.length > 0 ? Math.max(...lowers) : null;
  const upper = uppers.length > 0 ? Math.min(...uppers) : null;
  if (lower === null && upper === null) {
    reasons.push(
      item.targetValue !== null
        ? "This item carries a target value but neither a tolerance nor a min/max bound — a reading cannot be judged against a target alone."
        : "This item carries no acceptance bound (no min, no max, no target with tolerance) — a reading cannot be judged.",
    );
  }
  if (lower !== null && upper !== null && lower > upper + TOLERANCE_EPSILON) {
    reasons.push(
      `Acceptance bounds are contradictory: lower ${lower} is above upper ${upper}. No reading can satisfy them.`,
    );
  }
  return { lower, upper, reasons };
}

/** Build the display spec for a templated checklist item. */
export function specFromTemplateItem(row: ChecklistTemplateItem): ItemSpec {
  return {
    id: row.id,
    itemNumber: row.itemNumber,
    text: row.text,
    itemType: row.itemType,
    required: row.required === 1,
    options: row.options,
    targetValue: row.targetValue,
    minValue: row.minValue,
    maxValue: row.maxValue,
    tolerancePlus: row.tolerancePlus,
    toleranceMinus: row.toleranceMinus,
    unit: row.unit,
    acceptanceCriteria: row.acceptanceCriteria,
    guidance: row.guidance,
    specReference: row.specReference,
    weight: row.weight,
    isCritical: row.isCritical === 1,
    isHoldPoint: row.isHoldPoint === 1,
    photoRequired: row.photoRequired === 1,
    raisesNcrOnFail: row.raisesNcrOnFail === 1,
    section: row.section,
  };
}

/**
 * An ad-hoc checklist carries its item definition on the response row under
 * `detail.itemSpec` — the same shape the API reads back in `specFromResponse`.
 */
export function specFromResponseDetail(row: {
  id: string;
  itemNumber: string | null;
  questionText: string;
  itemType: string;
  unit: string | null;
  detail: Record<string, unknown>;
}): ItemSpec {
  const raw = (row.detail["itemSpec"] ?? {}) as Record<string, unknown>;
  const n = (key: string): number | null =>
    typeof raw[key] === "number" && Number.isFinite(raw[key]) ? (raw[key] as number) : null;
  const s = (key: string): string | null => (typeof raw[key] === "string" ? (raw[key] as string) : null);
  return {
    id: row.id,
    itemNumber: row.itemNumber,
    text: row.questionText,
    itemType: row.itemType,
    required: raw["required"] === true,
    options: Array.isArray(raw["options"]) ? (raw["options"] as string[]) : [],
    targetValue: n("targetValue"),
    minValue: n("minValue"),
    maxValue: n("maxValue"),
    tolerancePlus: n("tolerancePlus"),
    toleranceMinus: n("toleranceMinus"),
    unit: row.unit,
    acceptanceCriteria: s("acceptanceCriteria"),
    guidance: s("guidance"),
    specReference: s("specReference"),
    weight: typeof raw["weight"] === "number" ? (raw["weight"] as number) : 1,
    isCritical: raw["isCritical"] === true,
    isHoldPoint: raw["isHoldPoint"] === true,
    photoRequired: raw["photoRequired"] === true,
    raisesNcrOnFail: raw["raisesNcrOnFail"] === true,
    section: s("section"),
  };
}

export const NUMERIC_ITEM_TYPES = ["numeric", "measurement", "instrument_reading", "temperature"];
export const isNumericItemType = (t: string): boolean => NUMERIC_ITEM_TYPES.includes(t);
export const isStructuralItemType = (t: string): boolean => t === "section_header";

/* ================================================================== */
/* Reasons collected before a controlled act                           */
/* ================================================================== */

export interface ReasonRequest {
  title: string;
  description?: ReactNode;
  label?: string;
  hint?: string;
  confirmLabel?: string;
  destructive?: boolean;
}

/**
 * Collect a written reason before a controlled act.
 *
 * The API requires one on every waiver, rejection and reopening, because a
 * waived hold point only survives a challenge if the reason was written down
 * at the time. A native `prompt()` cannot say that; this can.
 */
export function useReason(): {
  ask: (request: ReasonRequest) => Promise<string | null>;
  dialog: ReactNode;
} {
  const [request, setRequest] = useState<ReasonRequest | null>(null);
  const [text, setText] = useState("");
  const resolver = useRef<((value: string | null) => void) | null>(null);

  const settle = useCallback((value: string | null) => {
    const resolve = resolver.current;
    resolver.current = null;
    setRequest(null);
    setText("");
    resolve?.(value);
  }, []);

  const ask = useCallback((next: ReasonRequest) => {
    resolver.current?.(null);
    setText("");
    setRequest(next);
    return new Promise<string | null>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const dialog = (
    <Modal
      open={request !== null}
      onClose={() => settle(null)}
      title={request?.title ?? "Reason"}
      {...(request?.destructive ? { tone: "danger" as const } : {})}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => settle(null)}>
            Cancel
          </Button>
          <Button
            variant={request?.destructive ? "danger" : "primary"}
            disabled={text.trim().length === 0}
            onClick={() => settle(text.trim())}
          >
            {request?.confirmLabel ?? "Continue"}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {request?.description ? (
          <p className="text-meta text-content-muted">{request.description}</p>
        ) : null}
        <Field
          label={request?.label ?? "Reason"}
          required
          hint={
            request?.hint ??
            "This is stored on the record and in the ledger, and is shown to everyone who reads it afterwards."
          }
        >
          <Textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
        </Field>
      </div>
    </Modal>
  );

  return { ask, dialog };
}

/* ================================================================== */
/* Small presentational pieces used by more than one tab               */
/* ================================================================== */

export function StatusBadge({
  status,
  tones,
  size = "xs",
}: {
  status: string | null | undefined;
  tones: Record<string, Tone>;
  size?: "xs" | "sm";
}) {
  if (!status) return <span className="text-content-subtle">{EM_DASH}</span>;
  return (
    <Badge tone={tones[status] ?? "neutral"} size={size} dot>
      {labelize(status)}
    </Badge>
  );
}

/** A key/value strip that reads as a record rather than a form. */
export function Facts({
  items,
  columns = 2,
}: {
  items: Array<{ label: string; value: ReactNode; hint?: ReactNode } | null>;
  columns?: 1 | 2 | 3;
}) {
  const rows = items.filter((i): i is { label: string; value: ReactNode; hint?: ReactNode } => i !== null);
  if (rows.length === 0) return null;
  return (
    <dl
      className={cx(
        "grid gap-x-4 gap-y-2.5",
        columns === 1 ? "grid-cols-1" : columns === 2 ? "sm:grid-cols-2" : "sm:grid-cols-3",
      )}
    >
      {rows.map((row) => (
        <div key={row.label}>
          <dt className="text-label uppercase tracking-wide text-content-subtle">{row.label}</dt>
          <dd className="mt-0.5 text-meta text-content">{row.value}</dd>
          {row.hint ? <dd className="mt-0.5 text-2xs text-content-subtle">{row.hint}</dd> : null}
        </div>
      ))}
    </dl>
  );
}

/** A section heading inside a drawer. */
export function SectionTitle({
  title,
  hint,
  actions,
}: {
  title: string;
  hint?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border-subtle pb-1.5">
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-content">{title}</h3>
        {hint ? <p className="mt-0.5 text-2xs text-content-subtle">{hint}</p> : null}
      </div>
      {actions ? <div className="shrink-0">{actions}</div> : null}
    </div>
  );
}

/** Query-string builder that drops empty filters. */
export function query(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  return search.toString();
}

export function useNonce(): [number, () => void] {
  const [nonce, setNonce] = useState(0);
  const bump = useCallback(() => setNonce((n) => n + 1), []);
  return [nonce, bump];
}

/** Shared memo helper: index a list by id. */
export function useIndex<T extends { id: string }>(rows: readonly T[] | undefined): Map<string, T> {
  return useMemo(() => new Map((rows ?? []).map((r) => [r.id, r] as const)), [rows]);
}
