/**
 * Shared machinery for the COMMITMENTS workspace — the buy side.
 *
 * THE HONESTY RULES, IMPLEMENTED ONCE HERE SO EVERY PANEL OBEYS THEM
 *
 *  1. A figure with no source renders its EMPTY STATE WITH THE REASON, never
 *     a zero. `{ value: null, reasons: [...] }` becomes "not available" plus
 *     the server's reasons, printed verbatim.
 *  2. Figures in different currencies are NEVER summed. Anything that totals
 *     buckets by currency first and says so out loud.
 *  3. A server refusal is rendered VERBATIM. The API writes long, specific
 *     sentences naming the discrepancy, the expired certificate and its date,
 *     or the segregation-of-duties control that fired. Paraphrasing them
 *     would destroy the only thing that makes the refusal actionable.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiClientError, api } from "../../lib/api";
import { Alert, Badge, Button, Card, CardBody, Field, Modal, Textarea } from "../../ui";
import { cx } from "../../ui/cx";
import { formatCurrency, formatNumber } from "../../ui/data";
import { toneClass, type Tone } from "../../ui/tokens";
import type {
  BuyoutLog,
  ChangeRegister,
  Commitment,
  CommitmentDetail,
  CommitmentList,
  ComplianceFinding,
  ComplianceReport,
  ComplianceResult,
  ComplianceStatus,
  Paginated,
  PaymentRegister,
  SovResponse,
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

export function pct(value: number | null | undefined, dp = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${formatNumber(value, { precision: dp })}%`;
}

export function isoDate(value: string | null | undefined): string {
  return value && value.length >= 10 ? value.slice(0, 10) : "—";
}

export function titleCase(value: string | null | undefined): string {
  if (!value) return "—";
  return value
    .split(/[_\s]+/)
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

export const KIND_LABEL: Record<string, string> = {
  subcontract: "Subcontract",
  purchase_order: "Purchase order",
};

export function statusToneOf(status: string): Tone {
  switch (status) {
    case "approved":
      return "success";
    case "complete":
      return "info";
    case "out_for_signature":
    case "out_for_bid":
      return "warning";
    case "terminated":
    case "void":
    case "rejected":
      return "danger";
    case "executed":
      return "success";
    case "draft":
      return "neutral";
    default:
      return "neutral";
  }
}

export function complianceTone(status: ComplianceStatus): Tone {
  return status === "blocked"
    ? "danger"
    : status === "warning"
      ? "warning"
      : status === "unknown"
        ? "neutral"
        : "success";
}

export const COMPLIANCE_LABEL: Record<ComplianceStatus, string> = {
  blocked: "Payment blocked",
  warning: "Warned",
  unknown: "Not asserted",
  compliant: "Compliant",
};

/* ================================================================== */
/* Server refusals, rendered verbatim                                  */
/* ================================================================== */

/**
 * A refusal from the API, decomposed but never rewritten.
 *
 * `message` is the server's sentence. `details` is whatever structured payload
 * the route attached to it — the compliance findings on a blocked payment, the
 * SOV discrepancy legs on an unbalanced schedule, the `control` name on a
 * segregation-of-duties refusal. Both are surfaced.
 */
export interface Refusal {
  status: number;
  message: string;
  control: string | null;
  remedy: string | null;
  blocking: ComplianceFinding[];
  warnings: ComplianceFinding[];
  /** anything else the route sent, printed as a key/value list */
  extra: Array<{ key: string; value: string }>;
}

const SUPPRESSED_DETAIL_KEYS = new Set(["control", "remedy", "blocking", "warnings"]);

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
      remedy: null,
      blocking: [],
      warnings: [],
      extra: [],
    };
  }
  const body = err.details as { details?: unknown } | undefined;
  const detail =
    body && typeof body === "object" && body.details && typeof body.details === "object"
      ? (body.details as Record<string, unknown>)
      : {};
  const findings = (key: string): ComplianceFinding[] =>
    Array.isArray(detail[key]) ? (detail[key] as ComplianceFinding[]) : [];
  const extra = Object.entries(detail)
    .filter(([k]) => !SUPPRESSED_DETAIL_KEYS.has(k))
    .map(([key, value]) => ({ key, value: stringifyDetail(value) }));
  return {
    status: err.status,
    message: err.message,
    control: typeof detail["control"] === "string" ? detail["control"] : null,
    remedy: typeof detail["remedy"] === "string" ? detail["remedy"] : null,
    blocking: findings("blocking"),
    warnings: findings("warnings"),
    extra,
  };
}

/**
 * The refusal panel. Deliberately loud and deliberately literal: the server's
 * sentence is the headline, its structured detail is underneath it, and
 * nothing is summarised into "something went wrong".
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
  const segregation =
    refusal.control === "no_self_approval" || refusal.control === "no_self_issue";
  /*
   * A segregation refusal is not a fault. Somebody tried to approve their own
   * commitment and the platform stopped them, which is the single financial
   * control worth more than all the others — so it is framed as the control
   * working rather than as an error the user should route around.
   */
  const heading = segregation
    ? "Segregation of duties — this control did its job"
    : refusal.control === "compliance_gate"
      ? "Refused by the compliance gate"
      : refusal.control !== null
        ? "Refused by a control"
        : "The server refused this";
  return (
    <Alert
      tone={segregation ? "warning" : "danger"}
      title={title ?? heading}
      {...(onDismiss ? { onDismiss } : {})}
      className="mb-3"
    >
      <p className="whitespace-pre-wrap">{refusal.message}</p>
      {refusal.control ? (
        <p className="mt-1 text-meta">
          Control: <code className="font-mono">{refusal.control}</code>
          {refusal.status ? ` · HTTP ${refusal.status}` : null}
        </p>
      ) : null}
      {refusal.blocking.length > 0 ? (
        <FindingList findings={refusal.blocking} heading="Blocking findings" />
      ) : null}
      {refusal.warnings.length > 0 ? (
        <FindingList findings={refusal.warnings} heading="Warnings recorded alongside" />
      ) : null}
      {refusal.remedy ? <p className="mt-2 text-meta">{refusal.remedy}</p> : null}
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

/** Findings printed exactly as the compliance engine wrote them. */
export function FindingList({
  findings,
  heading,
}: {
  findings: readonly ComplianceFinding[];
  heading?: string;
}) {
  if (findings.length === 0) return null;
  return (
    <div className="mt-2">
      {heading ? <p className="text-meta font-semibold">{heading}</p> : null}
      <ul className="mt-1 space-y-1.5">
        {findings.map((f, i) => (
          <li key={`${f.code}-${f.subjectId ?? i}`} className="flex items-start gap-2">
            <Badge tone={f.severity === "block" ? "danger" : "warning"} size="xs" variant="solid">
              {f.severity === "block" ? "Blocks" : "Warns"}
            </Badge>
            <div className="min-w-0">
              <p className="text-meta">{f.message}</p>
              <p className="text-2xs text-content-subtle">
                <code className="font-mono">{f.code}</code>
                {f.subjectType ? ` · ${titleCase(f.subjectType)}` : null}
                {f.expiredOn ? ` · expired ${f.expiredOn}` : null}
                {f.daysExpired !== null && f.daysExpired !== undefined
                  ? ` · ${f.daysExpired} day${f.daysExpired === 1 ? "" : "s"} ago`
                  : null}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ================================================================== */
/* Honest figures                                                      */
/* ================================================================== */

/**
 * An `Unknowable`. A null value is "not available" plus the server's reasons —
 * printed, not swallowed — because a zero here would read like an answer.
 */
export function Figure({
  figure,
  render,
  className,
}: {
  figure: Unknowable | null | undefined;
  render: (value: number) => ReactNode;
  className?: string;
}) {
  if (!figure) {
    return <span className={className}>—</span>;
  }
  if (figure.value === null) {
    return (
      <span className={className}>
        <span className="text-content-subtle italic">not available</span>
        {figure.reasons.length > 0 ? (
          <span className="mt-0.5 block text-2xs text-content-subtle">
            {figure.reasons.join(" ")}
          </span>
        ) : null}
      </span>
    );
  }
  return <span className={className}>{render(figure.value)}</span>;
}

/** A labelled money figure that states which currency it is in. */
export function MoneyStat({
  label,
  value,
  currency,
  hint,
  tone,
}: {
  label: string;
  value: number | null;
  currency: string;
  hint?: ReactNode;
  tone?: Tone;
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
        {value === null ? (
          <span className="text-sm font-normal italic text-content-subtle">not available</span>
        ) : (
          money(value, currency)
        )}
      </div>
      {hint ? <div className="mt-0.5 text-2xs text-content-subtle">{hint}</div> : null}
    </div>
  );
}

/**
 * A per-currency totals rail. Never one number: one block per currency, with
 * an explicit note when more than one is present.
 */
export function CurrencyTotalsRail({
  buckets,
  mixed,
}: {
  buckets: ReadonlyArray<{
    currency: string;
    commitmentCount: number;
    originalCommitmentSum: number;
    approvedChangeSum: number;
    revisedCommitmentSum: number;
    totalInvoiced: number;
    totalPaid: number;
    retainageHeld: number;
  }>;
  mixed: boolean;
}) {
  if (buckets.length === 0) return null;
  return (
    <div className="space-y-2">
      {mixed ? (
        <Alert tone="info" size="sm" title="More than one currency on this project">
          These commitments are written in {buckets.map((b) => b.currency).join(", ")}. The totals
          below are per currency and are never added together — there is no rate on the record and
          inventing one would be a fabrication.
        </Alert>
      ) : null}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {buckets.map((b) => (
          <Card key={b.currency}>
            <CardBody className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold">{b.currency}</span>
                <Badge tone="neutral" size="xs">
                  {b.commitmentCount} commitment{b.commitmentCount === 1 ? "" : "s"}
                </Badge>
              </div>
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-meta">
                <Row label="Original" value={money(b.originalCommitmentSum, b.currency)} />
                <Row label="Approved changes" value={money(b.approvedChangeSum, b.currency)} />
                <Row
                  label="Revised sum"
                  value={money(b.revisedCommitmentSum, b.currency)}
                  strong
                />
                <Row label="Invoiced" value={money(b.totalInvoiced, b.currency)} />
                <Row label="Paid" value={money(b.totalPaid, b.currency)} />
                <Row label="Retainage held" value={money(b.retainageHeld, b.currency)} />
              </dl>
            </CardBody>
          </Card>
        ))}
      </div>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="contents">
      <dt className="text-content-subtle">{label}</dt>
      <dd className={"text-right tabular-nums " + (strong ? "font-semibold" : "")}>{value}</dd>
    </div>
  );
}

/* ================================================================== */
/* Compliance presentation                                             */
/* ================================================================== */

/**
 * The compliance state of one commitment, on a row.
 *
 * Never a generic badge: the worst finding's own sentence travels with it, so
 * "GL certificate expired on 2026-03-14 (164 days ago)" is what the register
 * shows, not "Non-compliant".
 */
export function ComplianceCell({ result }: { result: ComplianceResult | undefined }) {
  if (!result) {
    return (
      <span className="text-meta italic text-content-subtle">
        not assessed
        <span className="mt-0.5 block text-2xs">
          The compliance register for this project has not loaded, so no position can be shown.
        </span>
      </span>
    );
  }
  const worst = result.blocking[0] ?? result.warnings[0] ?? null;
  return (
    <div className="min-w-0 py-0.5">
      <Badge tone={complianceTone(result.status)} dot variant="subtle" size="xs">
        {COMPLIANCE_LABEL[result.status]}
      </Badge>
      {worst ? (
        <p className="mt-0.5 whitespace-normal text-2xs leading-snug text-content-muted">
          {worst.message}
        </p>
      ) : result.status === "unknown" && result.note ? (
        <p className="mt-0.5 whitespace-normal text-2xs leading-snug text-content-subtle">
          {result.note}
        </p>
      ) : null}
      {result.blocking.length + result.warnings.length > 1 ? (
        <p className="mt-0.5 text-2xs text-content-subtle">
          +{result.blocking.length + result.warnings.length - 1} more finding
          {result.blocking.length + result.warnings.length - 1 === 1 ? "" : "s"}
        </p>
      ) : null}
    </div>
  );
}

/** The full compliance position, for a detail pane. */
export function CompliancePosition({ result }: { result: ComplianceResult }) {
  const tone = complianceTone(result.status);
  return (
    <div className="space-y-3">
      <Alert
        tone={tone}
        title={`${COMPLIANCE_LABEL[result.status]} — assessed ${result.asOf}`}
        variant="subtle"
      >
        {result.note ? <p>{result.note}</p> : null}
        <p className="mt-1 text-meta">
          Strictness on this commitment is <strong>{result.strictness}</strong>. Evidence consulted:{" "}
          {result.evidence.certificatesConsidered} certificate
          {result.evidence.certificatesConsidered === 1 ? "" : "s"},{" "}
          {result.evidence.bondsConsidered} bond
          {result.evidence.bondsConsidered === 1 ? "" : "s"},{" "}
          {result.evidence.lienWaiversConsidered} lien waiver
          {result.evidence.lienWaiversConsidered === 1 ? "" : "s"}.
        </p>
        {!result.requirementsKnown ? (
          <p className="mt-1 text-meta">
            No insurance or bond requirement is recorded, so this commitment is reported as
            <strong> not asserted</strong> — not as compliant.
          </p>
        ) : null}
      </Alert>
      <FindingList findings={result.blocking} heading="Blocking — payment is refused" />
      <FindingList findings={result.warnings} heading="Warnings — payment is permitted" />
      {result.findings.length === 0 ? (
        <p className="text-meta text-content-subtle">
          No findings against the requirements recorded on this commitment.
        </p>
      ) : null}
      <div className="rounded-lg border border-border bg-surface-raised/50 p-3 text-meta">
        <p className="font-semibold">What this commitment requires of its vendor</p>
        <dl className="mt-1.5 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
          <dt className="text-content-subtle">Policy types</dt>
          <dd>
            {result.requirements.requiredPolicyTypes.length > 0
              ? result.requirements.requiredPolicyTypes.map(titleCase).join(", ")
              : "none recorded"}
          </dd>
          <dt className="text-content-subtle">Bond types</dt>
          <dd>
            {result.requirements.requiredBondTypes.length > 0
              ? result.requirements.requiredBondTypes.map(titleCase).join(", ")
              : "none recorded"}
          </dd>
          <dt className="text-content-subtle">Minimum limit</dt>
          <dd>
            {result.requirements.minimumInsuranceLimit === null
              ? "none recorded"
              : formatNumber(result.requirements.minimumInsuranceLimit, { precision: 2 })}
          </dd>
          <dt className="text-content-subtle">Minimum bond</dt>
          <dd>
            {result.requirements.minimumBondPercent === null
              ? "none recorded"
              : `${result.requirements.minimumBondPercent}% of the revised commitment sum`}
          </dd>
          <dt className="text-content-subtle">Verified certificates</dt>
          <dd>{result.requirements.requireVerifiedCertificates ? "required" : "not required"}</dd>
        </dl>
        {result.requirements.notes ? (
          <p className="mt-2 text-content-muted">{result.requirements.notes}</p>
        ) : null}
      </div>
    </div>
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
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

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

export interface RegisterFilters {
  kind: string;
  status: string;
  vendorId: string;
  q: string;
}

export const EMPTY_FILTERS: RegisterFilters = { kind: "", status: "", vendorId: "", q: "" };

export function useCommitmentRegister(
  projectId: string | undefined,
  filters: RegisterFilters,
): Loadable<CommitmentList> {
  const path = useMemo(() => {
    if (!projectId) return null;
    const params = new URLSearchParams({ page: "1", pageSize: "200" });
    if (filters.kind) params.set("kind", filters.kind);
    if (filters.status) params.set("status", filters.status);
    if (filters.vendorId) params.set("vendorId", filters.vendorId);
    if (filters.q) params.set("q", filters.q);
    return `/api/v1/projects/${projectId}/commitments?${params.toString()}`;
  }, [projectId, filters.kind, filters.status, filters.vendorId, filters.q]);
  return useResource<CommitmentList>(path);
}

export function useComplianceReport(projectId: string | undefined): Loadable<ComplianceReport> {
  return useResource<ComplianceReport>(
    projectId ? `/api/v1/projects/${projectId}/commitments/compliance` : null,
  );
}

export function useBuyoutLog(projectId: string | undefined): Loadable<BuyoutLog> {
  return useResource<BuyoutLog>(
    projectId ? `/api/v1/projects/${projectId}/commitments/rollups/buyout-log` : null,
  );
}

export function useCommitmentDetail(commitmentId: string | null): Loadable<CommitmentDetail> {
  return useResource<CommitmentDetail>(
    commitmentId ? `/api/v1/commitments/${commitmentId}` : null,
  );
}

export function useSov(commitmentId: string | null): Loadable<SovResponse> {
  return useResource<SovResponse>(commitmentId ? `/api/v1/commitments/${commitmentId}/sov` : null);
}

export function useChanges(commitmentId: string | null): Loadable<ChangeRegister> {
  return useResource<ChangeRegister>(
    commitmentId ? `/api/v1/commitments/${commitmentId}/changes?page=1&pageSize=200` : null,
  );
}

export function usePayments(commitmentId: string | null): Loadable<PaymentRegister> {
  return useResource<PaymentRegister>(
    commitmentId ? `/api/v1/commitments/${commitmentId}/payments?page=1&pageSize=200` : null,
  );
}

export function useVendors(): Loadable<Paginated<Vendor>> {
  return useResource<Paginated<Vendor>>("/api/v1/vendors?page=1&pageSize=200");
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
  return { busy, refusal, clear: () => setRefusal(null), run };
}

/* ================================================================== */
/* Reasons                                                             */
/* ================================================================== */

export interface ReasonRequest {
  title: string;
  description?: ReactNode;
  label?: string;
  confirmLabel?: string;
  destructive?: boolean;
}

/**
 * Collect a written reason before a destructive or controlled act.
 *
 * The API requires a reason on every one of these — voiding, terminating,
 * holding payment, rejecting a change order — because the reason travels with
 * the record afterwards instead of living in somebody's inbox. A native
 * `prompt()` is not good enough for that: it is blocked outright in some
 * embedding contexts, and it cannot say why the reason is being asked for.
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
      tone={request?.destructive ? "danger" : undefined}
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
          hint="This is stored on the record and in the ledger, and is shown to everyone who reads it afterwards."
        >
          <Textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
        </Field>
      </div>
    </Modal>
  );

  return { ask, dialog };
}

/** The revised sum a change order moves the commitment to, as an arithmetic. */
export function changeArithmetic(
  change: { amount: number; revisedCommitmentSum: number; status: string },
  currency: string,
): { before: number | null; delta: number; after: number | null; settled: boolean } {
  const settled = change.status === "approved" || change.status === "executed";
  if (!settled) return { before: null, delta: change.amount, after: null, settled: false };
  return {
    before: Number((change.revisedCommitmentSum - change.amount).toFixed(2)),
    delta: change.amount,
    after: change.revisedCommitmentSum,
    settled: true,
  };
}

/** Only these commitments can take a change order or a payment. */
export function isLive(commitment: Commitment): boolean {
  return commitment.status !== "void" && commitment.status !== "terminated";
}
