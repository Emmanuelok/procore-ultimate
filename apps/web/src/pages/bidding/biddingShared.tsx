/**
 * Shared machinery for the BIDDING & PREQUALIFICATION workspace.
 *
 * FOUR RULES, IMPLEMENTED ONCE HERE SO EVERY TAB OBEYS THEM
 *
 *  1. WITHHELD IS NOT ZERO. While a package is sealed the API returns every
 *     price as `null` with the key retained. `<Sealed>` renders that as the
 *     word "sealed" with the server's own note behind it — never a blank cell,
 *     never a dash that reads like nil, and never a 0.
 *
 *  2. NULL IS NOT ZERO EITHER. `{ value: null, reasons: [...] }` renders as
 *     "not available" plus the reasons, printed verbatim. The whole levelling
 *     failure mode — the lowest bid being whoever excluded most — is only
 *     visible because an excluded scope with no adjustment refuses to produce
 *     a number and says why.
 *
 *  3. MONEY CARRIES ITS CURRENCY AND IS NEVER SUMMED ACROSS ONE. Anything
 *     that totals says which currency it is in.
 *
 *  4. A SERVER REFUSAL IS RENDERED VERBATIM. The bidding API writes long,
 *     specific sentences — the not-lowest control, the segregation control,
 *     the seal, the levelling blockers. Paraphrasing them would destroy the
 *     only thing that makes them actionable.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ApiClientError, api } from "../../lib/api";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  Field,
  Modal,
  Skeleton,
  SkeletonTable,
  Textarea,
} from "../../ui";
import { formatCurrency, formatNumber } from "../../ui/data";
import { cx } from "../../ui/cx";
import { toneClass, type Tone } from "../../ui/tokens";
import { IconLock, IconWarning } from "../../ui/icons";
import type {
  CompanyUser,
  ListResponse,
  LimitCheck,
  Paginated,
  PrequalState,
  RecommendedLimit,
  SealState,
  Unknowable,
  Vendor,
} from "./types";

/* ================================================================== */
/* Formatting                                                          */
/* ================================================================== */

/** Money always carries its currency; there is no "the" currency here. */
export function money(value: number | null | undefined, currency: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return formatCurrency(value, { currency, precision: 2 });
}

export function num(value: number | null | undefined, dp = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return formatNumber(value, { precision: dp });
}

export function pct(value: number | null | undefined, dp = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${formatNumber(value, { precision: dp })}%`;
}

export function isoDate(value: string | null | undefined): string {
  return value && value.length >= 10 ? value.slice(0, 10) : "—";
}

export function dateTime(value: string | null | undefined): string {
  if (!value) return "—";
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

export function titleCase(value: string | null | undefined): string {
  if (!value) return "—";
  return value
    .split(/[_\s]+/)
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/* ================================================================== */
/* Tones                                                               */
/* ================================================================== */

export function packageTone(status: string): Tone {
  switch (status) {
    case "awarded":
      return "success";
    case "partially_awarded":
      return "info";
    case "levelled":
    case "under_evaluation":
      return "highlight";
    case "open":
    case "invitations_sent":
      return "info";
    case "closed":
      return "warning";
    case "cancelled":
      return "danger";
    case "on_hold":
      return "warning";
    default:
      return "neutral";
  }
}

export function invitationTone(status: string): Tone {
  switch (status) {
    case "submitted":
    case "intent_to_bid":
      return "success";
    case "viewed":
    case "downloaded":
    case "delivered":
      return "info";
    case "declined":
    case "no_response":
      return "warning";
    case "bounced":
    case "disqualified":
    case "withdrawn":
      return "danger";
    default:
      return "neutral";
  }
}

export function submissionTone(status: string): Tone {
  switch (status) {
    case "awarded":
    case "shortlisted":
      return "success";
    case "opened":
    case "under_review":
    case "clarified":
      return "info";
    case "clarification_requested":
      return "warning";
    case "unsuccessful":
    case "withdrawn":
      return "neutral";
    default:
      return "neutral";
  }
}

export function complianceTone(status: string): Tone {
  switch (status) {
    case "compliant":
      return "success";
    case "qualified":
    case "conditional":
      return "warning";
    case "non_compliant":
      return "danger";
    default:
      return "neutral";
  }
}

export function awardTone(status: string): Tone {
  switch (status) {
    case "executed":
    case "approved":
      return "success";
    case "contract_issued":
    case "letter_of_intent":
      return "info";
    case "recommended":
    case "pending_approval":
      return "warning";
    case "rejected":
    case "withdrawn":
    case "cancelled":
      return "danger";
    default:
      return "neutral";
  }
}

export const PREQUAL_TONE: Record<PrequalState, Tone> = {
  approved: "success",
  expiring: "warning",
  lapsed: "danger",
  suspended: "danger",
  rejected: "danger",
  in_progress: "info",
  none: "neutral",
};

export const PREQUAL_LABEL: Record<PrequalState, string> = {
  approved: "Prequalified",
  expiring: "Expiring",
  lapsed: "Lapsed",
  suspended: "Suspended",
  rejected: "Rejected",
  in_progress: "Undecided",
  none: "Never prequalified",
};

export const INCLUSION_LABEL: Record<string, string> = {
  included: "Included",
  excluded: "Excluded",
  partially_included: "Partial",
  unclear: "Unclear",
  not_priced: "Not priced",
};

export const INCLUSION_TONE: Record<string, Tone> = {
  included: "success",
  excluded: "danger",
  partially_included: "warning",
  unclear: "warning",
  not_priced: "neutral",
};

export const LEVELLING_ADJUSTMENT_REASONS = [
  "scope_gap",
  "scope_overlap",
  "quantity_correction",
  "arithmetic_error",
  "exclusion_priced_elsewhere",
  "alternate_substitution",
  "commercial_term",
  "programme_impact",
  "tax_treatment",
  "currency",
  "risk_allowance",
  "prelims_normalisation",
  "other",
] as const;

export const LEVELLING_INCLUSIONS = [
  "included",
  "excluded",
  "partially_included",
  "unclear",
  "not_priced",
] as const;

export const LEVELLING_ITEM_CATEGORIES = [
  "base_scope",
  "alternate",
  "provisional_sum",
  "allowance",
  "rate_only",
  "exclusion_check",
  "commercial_term",
  "qualification",
] as const;

/* ================================================================== */
/* Server refusals, rendered verbatim                                  */
/* ================================================================== */

export interface Refusal {
  status: number;
  message: string;
  /** the named control that fired, when the route named one */
  control: string | null;
  reasons: string[];
  /** everything else the route attached, printed as key/value */
  extra: Array<{ key: string; value: string }>;
}

const SUPPRESSED_DETAIL_KEYS = new Set(["control", "reasons", "errors"]);

function stringifyDetail(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

export function refusalFrom(err: unknown): Refusal {
  if (!(err instanceof ApiClientError)) {
    return {
      status: 0,
      message: err instanceof Error ? err.message : "The request failed.",
      control: null,
      reasons: [],
      extra: [],
    };
  }
  const body = err.details as { details?: unknown } | undefined;
  const detail =
    body && typeof body === "object" && body.details && typeof body.details === "object"
      ? (body.details as Record<string, unknown>)
      : {};
  const listOf = (key: string): string[] =>
    Array.isArray(detail[key]) ? (detail[key] as unknown[]).map(stringifyDetail) : [];
  const extra = Object.entries(detail)
    .filter(([k]) => !SUPPRESSED_DETAIL_KEYS.has(k))
    .map(([key, value]) => ({ key, value: stringifyDetail(value) }));
  return {
    status: err.status,
    message: err.message,
    control: typeof detail["control"] === "string" ? detail["control"] : null,
    reasons: [...listOf("reasons"), ...listOf("errors")],
    extra,
  };
}

const CONTROL_HEADING: Record<string, string> = {
  no_self_approval: "Segregation of duties — this control did its job",
  not_lowest_requires_justification:
    "This is not the lowest bid, and the platform will not record it without the reason",
};

/**
 * The refusal panel. Deliberately loud and deliberately literal: the server's
 * sentence is the headline and nothing is summarised into "something went
 * wrong". A segregation or not-lowest refusal is framed as the control working
 * rather than as an error to route around.
 */
export function RefusalPanel({
  refusal,
  title,
  onDismiss,
}: {
  refusal: Refusal | null;
  title?: string;
  onDismiss?: () => void;
}) {
  if (!refusal) return null;
  const controlled = refusal.control !== null && refusal.control in CONTROL_HEADING;
  const heading =
    title ??
    (refusal.control ? CONTROL_HEADING[refusal.control] : undefined) ??
    (refusal.control ? "Refused by a control" : "The server refused this");
  return (
    <Alert
      tone={controlled ? "warning" : "danger"}
      title={heading}
      onDismiss={onDismiss}
      className="mb-3"
    >
      <p className="whitespace-pre-wrap">{refusal.message}</p>
      {refusal.control ? (
        <p className="mt-1 text-meta">
          Control: <code className="font-mono">{refusal.control}</code>
          {refusal.status ? ` · HTTP ${refusal.status}` : null}
        </p>
      ) : null}
      {refusal.reasons.length > 0 ? (
        <ul className="mt-2 list-disc space-y-1 pl-4 text-meta">
          {refusal.reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
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

/* ================================================================== */
/* Honest figures                                                      */
/* ================================================================== */

/**
 * An `Unknowable`. A null value is "not available" plus the server's reasons —
 * printed, not swallowed — because a zero here would read like an answer, and
 * in procurement a zero that reads like an answer decides an award.
 */
export function Figure({
  figure,
  render,
  className,
  reasonClassName,
  showReasons = true,
}: {
  figure: Unknowable | null | undefined;
  render: (value: number) => ReactNode;
  className?: string;
  reasonClassName?: string;
  showReasons?: boolean;
}) {
  if (!figure) return <span className={className}>—</span>;
  if (figure.value === null) {
    return (
      <span className={className}>
        <span className="italic text-content-subtle">not available</span>
        {showReasons && figure.reasons.length > 0 ? (
          <span className={cx("mt-0.5 block text-2xs leading-snug text-content-subtle", reasonClassName)}>
            {figure.reasons.join(" ")}
          </span>
        ) : null}
      </span>
    );
  }
  return <span className={className}>{render(figure.value)}</span>;
}

/** A list of reasons, printed exactly as the server wrote them. */
export function ReasonList({
  reasons,
  heading,
  tone = "neutral",
  className,
}: {
  reasons: readonly string[];
  heading?: ReactNode;
  tone?: Tone;
  className?: string;
}) {
  if (reasons.length === 0) return null;
  return (
    <div className={cx("text-meta", className)}>
      {heading ? <p className="font-semibold">{heading}</p> : null}
      <ul className="mt-1 space-y-1">
        {reasons.map((r, i) => (
          <li key={i} className="flex gap-2">
            <span className={cx("mt-1.5 h-1 w-1 shrink-0 rounded-full", toneClass(tone, "dot"))} />
            <span className="text-content-muted">{r}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A labelled money figure that states which currency it is in. */
export function MoneyStat({
  label,
  value,
  currency,
  hint,
  tone,
  sealed,
}: {
  label: string;
  value: number | null;
  currency: string;
  hint?: ReactNode;
  tone?: Tone;
  sealed?: boolean;
}) {
  return (
    <div>
      <div className="text-label uppercase text-content-subtle">{label}</div>
      <div
        className={cx(
          "mt-0.5 text-base font-semibold tabular-nums",
          tone ? toneClass(tone, "text") : "text-content",
        )}
      >
        {sealed ? (
          <span className="inline-flex items-center gap-1 text-sm font-medium text-warning-fg">
            <IconLock className="h-3.5 w-3.5" aria-hidden />
            sealed
          </span>
        ) : value === null ? (
          <span className="text-sm font-normal italic text-content-subtle">not available</span>
        ) : (
          money(value, currency)
        )}
      </div>
      {hint ? <div className="mt-0.5 text-2xs text-content-subtle">{hint}</div> : null}
    </div>
  );
}

/* ================================================================== */
/* The seal, rendered as the control it is                             */
/* ================================================================== */

/**
 * A withheld price. NOT a blank, NOT a dash, NOT a zero — the word "sealed",
 * in the warning tone, with the lock. Distinguishing "withheld" from "nil" is
 * the entire reason the API keeps the key and nulls the value.
 */
export function Sealed({ compact = false }: { compact?: boolean }) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium",
        "bg-warning-subtle text-warning-fg",
        compact ? "text-2xs" : "text-xs",
      )}
      title="Withheld while the package is sealed — this is not a zero and not a blank."
    >
      <IconLock className={compact ? "h-3 w-3" : "h-3.5 w-3.5"} aria-hidden />
      sealed
    </span>
  );
}

/** A money cell that knows about the seal. */
export function AmountCell({
  value,
  currency,
  sealed,
  className,
}: {
  value: number | null | undefined;
  currency: string;
  sealed: boolean;
  className?: string;
}) {
  if (sealed) return <Sealed compact />;
  if (value === null || value === undefined) {
    return <span className={cx("italic text-content-subtle", className)}>not stated</span>;
  }
  return <span className={cx("tabular-nums", className)}>{money(value, currency)}</span>;
}

/**
 * The seal banner: the position, the opening requirements, and the two people
 * the opening needs. Shown wherever prices are (or are not) on screen.
 */
export function SealBanner({
  seal,
  onOpen,
  busy,
}: {
  seal: SealState;
  onOpen?: () => void;
  busy?: boolean;
}) {
  if (!seal.isSealed) {
    return (
      <Alert tone="neutral" variant="subtle" size="sm" title="Not a sealed package" icon={false}>
        {seal.note}
      </Alert>
    );
  }
  const tone: Tone = seal.amountsWithheld ? (seal.mayOpenNow ? "warning" : "info") : "success";
  return (
    <Alert
      tone={tone}
      title={
        seal.isOpened
          ? "Seal broken — amounts are readable"
          : seal.mayOpenNow
            ? "The seal may now be lifted — no opening has been recorded"
            : "Sealed — every price is withheld"
      }
      icon={IconLock}
      actions={
        onOpen && !seal.isOpened ? (
          <Button size="sm" variant="secondary" onClick={onOpen} disabled={busy || !seal.mayOpenNow}>
            Record the opening
          </Button>
        ) : null
      }
    >
      <p className="whitespace-pre-wrap">{seal.note}</p>
      <dl className="mt-2 grid gap-x-6 gap-y-1 text-meta sm:grid-cols-2">
        <Pair label="Seal lifts at" value={seal.opensAt ? dateTime(seal.opensAt) : "not set"} />
        <Pair
          label="Time passed"
          value={seal.mayOpenNow ? "yes" : "no — opening early is refused"}
        />
        <Pair
          label="Witness"
          value={
            seal.requiresWitness
              ? "required, and may not be the opener"
              : "waived on this package — a recorded decision"
          }
        />
        <Pair
          label="Opened by / witnessed by"
          value={
            seal.openedBy
              ? `${seal.openedBy} / ${seal.witnessedBy ?? "no witness recorded"}`
              : "not yet opened"
          }
        />
      </dl>
    </Alert>
  );
}

function Pair({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="contents">
      <div className="flex justify-between gap-3 sm:contents">
        <dt className="text-content-subtle">{label}</dt>
        <dd className="font-medium">{value}</dd>
      </div>
    </div>
  );
}

/* ================================================================== */
/* Capacity                                                            */
/* ================================================================== */

const SEVERITY_TONE: Record<LimitCheck["severity"], Tone> = {
  none: "success",
  info: "info",
  warning: "warning",
  critical: "danger",
};

/** The single-project limit check, with the sentence the API wrote for it. */
export function CapacityNote({ check, compact }: { check: LimitCheck | null; compact?: boolean }) {
  if (!check) {
    return (
      <span className="text-2xs italic text-content-subtle">
        no capacity test — the contract value is withheld while the package is sealed
      </span>
    );
  }
  const tone = SEVERITY_TONE[check.severity];
  if (compact) {
    return (
      <div className="min-w-0">
        <Badge tone={check.exceeds === null ? "neutral" : tone} size="xs" variant="subtle" dot>
          {check.exceeds === null
            ? "no limit on record"
            : check.exceeds
              ? "over the approved limit"
              : "within limit"}
        </Badge>
        <p className="mt-0.5 whitespace-normal text-2xs leading-snug text-content-muted">
          {check.message}
        </p>
      </div>
    );
  }
  return (
    <Alert tone={check.exceeds === null ? "neutral" : tone} variant="subtle" size="sm">
      <p>{check.message}</p>
      {check.limit !== null && check.limitCurrency ? (
        <p className="mt-1 text-meta text-content-subtle">
          Contract {money(check.contractValue, check.contractCurrency)} against a limit of{" "}
          {money(check.limit, check.limitCurrency)}
          {check.ratio !== null ? ` — ${num(check.ratio * 100, 0)}% of it` : null}.
        </p>
      ) : null}
    </Alert>
  );
}

/** The recommended single-project limit, always with its stated basis. */
export function RecommendedLimitCard({ limit }: { limit: RecommendedLimit | null }) {
  if (!limit) {
    return (
      <EmptyState
        size="sm"
        title="No financial screening on record"
        hint="No accounts have been recorded for this vendor, so no single-project limit has been derived. The platform will not guess one: a cap with no figures behind it is a number the vendor cannot argue with and the buyer cannot defend."
      />
    );
  }
  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <div className="text-label uppercase text-content-subtle">
              Recommended single-project limit
            </div>
            <div className="mt-0.5 text-xl font-semibold tabular-nums">
              {limit.value === null ? (
                <span className="text-base font-normal italic text-content-subtle">
                  not available
                </span>
              ) : (
                money(limit.value, limit.currency)
              )}
            </div>
          </div>
          {limit.bindingTest ? (
            <Badge tone={limit.bindingTest === "hard_stop" ? "danger" : "info"} size="sm">
              {limit.bindingTest === "hard_stop"
                ? "Hard stop"
                : `Bound by ${titleCase(limit.bindingTest)}`}
            </Badge>
          ) : null}
        </div>

        <p className="text-meta leading-relaxed text-content-muted">{limit.basis}</p>

        {limit.value === null ? (
          <ReasonList reasons={limit.reasons} heading="Why no figure was produced" tone="warning" />
        ) : null}

        <div>
          <p className="text-label uppercase text-content-subtle">The three tests</p>
          <ul className="mt-1 space-y-1.5">
            {limit.tests.map((t) => (
              <li
                key={t.key}
                className={cx(
                  "rounded-md border p-2",
                  t.key === limit.bindingTest
                    ? "border-info-border bg-info-subtle"
                    : "border-border bg-surface-raised",
                )}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-meta font-medium">{t.label}</span>
                  <span className="text-meta tabular-nums">
                    {t.value === null ? (
                      <span className="italic text-content-subtle">not applicable</span>
                    ) : (
                      money(t.value, limit.currency)
                    )}
                  </span>
                </div>
                <p className="mt-0.5 text-2xs leading-snug text-content-subtle">{t.detail}</p>
              </li>
            ))}
          </ul>
        </div>

        {limit.factors.length > 0 ? (
          <div>
            <p className="text-label uppercase text-content-subtle">
              Haircuts applied
              {limit.headroomBeforeFactors !== null
                ? ` — from ${money(limit.headroomBeforeFactors, limit.currency)}`
                : null}
            </p>
            <ul className="mt-1 space-y-1">
              {limit.factors.map((f) => (
                <li key={f.key} className="flex gap-2 text-meta">
                  <Badge tone="warning" size="xs">
                    ×{f.factor}
                  </Badge>
                  <span className="text-content-muted">{f.why}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

/* ================================================================== */
/* Loading / error framing                                             */
/* ================================================================== */

/** Skeletons, never spinners. */
export function LoadingBlock({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <Skeleton height={64} radius="lg" />
        <Skeleton height={64} radius="lg" />
        <Skeleton height={64} radius="lg" />
      </div>
      <SkeletonTable rows={rows} columns={5} />
    </div>
  );
}

export function LoadError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <Alert
      tone="danger"
      title="This did not load"
      icon={IconWarning}
      actions={
        onRetry ? (
          <Button size="sm" variant="secondary" onClick={onRetry}>
            Try again
          </Button>
        ) : null
      }
    >
      <p className="whitespace-pre-wrap">{message}</p>
    </Alert>
  );
}

/* ================================================================== */
/* Data hooks                                                          */
/* ================================================================== */

export interface Loadable<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/** One GET, reloadable, aborting on unmount. `path` null means "not yet". */
export function useResource<T>(path: string | null): Loadable<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (path === null) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api
      .get<T>(path, { signal: controller.signal })
      .then((res) => {
        if (controller.signal.aborted) return;
        setData(res);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "The request failed.");
        setLoading(false);
      });
    return () => controller.abort();
  }, [path, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, loading, error, reload };
}

/**
 * A mutation with its refusal held next to it. Nothing here catches an error
 * and shrugs: the `Refusal` is kept so the panel that owns the action can
 * print the server's own words.
 */
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

export function useVendors(): Loadable<Paginated<Vendor>> {
  return useResource<Paginated<Vendor>>("/api/v1/vendors?page=1&pageSize=200");
}

/** Actor id → name, falling back to the id so a row is never blank. */
export function useCompanyUsers(): Map<string, string> {
  const [byId, setById] = useState<Map<string, string>>(() => new Map());
  useEffect(() => {
    let cancelled = false;
    api
      .get<ListResponse<CompanyUser>>("/api/v1/company/users?page=1&pageSize=200")
      .then((res) => {
        if (cancelled) return;
        setById(new Map(res.items.map((u) => [u.id, u.name || u.email])));
      })
      .catch(() => {
        /* names are a courtesy; ids still render */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return byId;
}

export function useNames(): (id: string | null | undefined) => string {
  const users = useCompanyUsers();
  return useCallback(
    (id: string | null | undefined) => (id ? (users.get(id) ?? id) : "—"),
    [users],
  );
}

/* ================================================================== */
/* Reasons                                                             */
/* ================================================================== */

export interface ReasonRequest {
  title: string;
  description?: ReactNode;
  label?: string;
  hint?: string;
  confirmLabel?: string;
  destructive?: boolean;
  /** the API's own floor — `reasonSchema` is 3 chars, `justificationSchema` 20 */
  minLength?: number;
}

/**
 * Collect a written reason before a controlled act.
 *
 * The API requires one on every one of these — cancelling a package, accepting
 * a late bid, justifying an award that is not the lowest — because the reason
 * travels with the record afterwards instead of living in somebody's inbox.
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

  const min = request?.minLength ?? 3;
  const short = text.trim().length < min;

  const dialog = (
    <Modal
      open={request !== null}
      onClose={() => settle(null)}
      title={request?.title ?? "Reason"}
      tone={request?.destructive ? "danger" : undefined}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => settle(null)}>
            Cancel
          </Button>
          <Button
            variant={request?.destructive ? "danger" : "primary"}
            disabled={short}
            onClick={() => settle(text.trim())}
          >
            {request?.confirmLabel ?? "Continue"}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {request?.description ? (
          <div className="text-meta leading-relaxed text-content-muted">{request.description}</div>
        ) : null}
        <Field
          label={request?.label ?? "Reason"}
          required
          hint={
            request?.hint ??
            "Stored on the record and in the ledger, and shown to everyone who reads it afterwards."
          }
          error={
            short && text.length > 0
              ? `The API requires at least ${min} characters — a one-word reason is the same as no reason at all.`
              : null
          }
        >
          <Textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
        </Field>
      </div>
    </Modal>
  );

  return { ask, dialog };
}

/* ================================================================== */
/* Small helpers                                                       */
/* ================================================================== */

/** The distinct currencies in a set, upper-cased and sorted. */
export function distinctCurrencies(values: ReadonlyArray<string | null | undefined>): string[] {
  return [...new Set(values.filter((c): c is string => Boolean(c)).map((c) => c.toUpperCase()))].sort();
}

export function useMixedCurrencyNote(values: ReadonlyArray<string | null | undefined>): {
  currencies: string[];
  mixed: boolean;
  note: string | null;
} {
  return useMemo(() => {
    const currencies = distinctCurrencies(values);
    const mixed = currencies.length > 1;
    return {
      currencies,
      mixed,
      note: mixed
        ? `These bids are priced in ${currencies.join(", ")}. Figures in different currencies are ` +
          "never summed and never ranked against each other here — no rate is on the record, and " +
          "choosing one would be choosing the winner."
        : null,
    };
  }, [values]);
}
