/**
 * Shared machinery for the PRIME CONTRACT workspace — the sell side.
 *
 * The identity this whole module is built around is `Σ SOV = the contract sum`.
 * A G703 that does not total the G702's line 3 is not a continuation sheet, it
 * is a spreadsheet with a coincidence in it. So the identity is stated on every
 * screen that touches either side of it, and when the server refuses an edit
 * that would break it, the refusal — which names the discrepancy, its
 * direction, its size and which leg failed — is printed exactly as sent.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiClientError, api } from "../../lib/api";
import { Alert, Badge, Button, Card, CardBody, Field, Modal, Textarea } from "../../ui";
import { cx } from "../../ui/cx";
import { formatCurrency, formatNumber } from "../../ui/data";
import { toneClass, type Tone } from "../../ui/tokens";
import type {
  BillingView,
  Component,
  ContractSummary,
  ContractView,
  Identity,
  Paginated,
  PaymentApplication,
  PrimeChange,
  PrimeContract,
  SovView,
  Vendor,
} from "./types";

/* ================================================================== */
/* Formatting                                                          */
/* ================================================================== */

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

export function statusToneOf(status: string): Tone {
  switch (status) {
    case "approved":
    case "certified":
    case "executed":
    case "paid":
      return "success";
    case "complete":
    case "submitted":
      return "info";
    case "partially_certified":
    case "out_for_signature":
    case "out_for_bid":
    case "pending_owner_approval":
    case "pending_in_house_review":
      return "warning";
    case "terminated":
    case "void":
    case "rejected":
      return "danger";
    default:
      return "neutral";
  }
}

/* ================================================================== */
/* Honest figures                                                      */
/* ================================================================== */

/**
 * A `Component`. The API sends `{ value: null, inputs, reasons }` whenever it
 * could not derive a figure — percent complete against a zero contract sum, a
 * combined total across two currencies — and this renders that as "not
 * available" with the reasons printed, never as a zero.
 */
export function ComponentValue({
  component,
  render,
  className,
}: {
  component: Component | null | undefined;
  render: (value: number) => ReactNode;
  className?: string;
}) {
  if (!component) return <span className={className}>—</span>;
  if (component.value === null) {
    return (
      <span className={className}>
        <span className="italic text-content-subtle">not available</span>
        {component.reasons.length > 0 ? (
          <span className="mt-0.5 block text-2xs text-content-subtle">
            {component.reasons.join(" ")}
          </span>
        ) : null}
      </span>
    );
  }
  return <span className={className}>{render(component.value)}</span>;
}

export function MoneyStat({
  label,
  value,
  currency,
  hint,
  tone,
  size = "md",
}: {
  label: ReactNode;
  value: number | null;
  currency: string;
  hint?: ReactNode;
  tone?: Tone;
  size?: "sm" | "md" | "lg";
}) {
  return (
    <div>
      <div className="text-label uppercase text-content-subtle">{label}</div>
      <div
        className={cx(
          "mt-0.5 font-semibold tabular-nums",
          size === "lg" ? "text-xl" : size === "sm" ? "text-sm" : "text-base",
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

/* ================================================================== */
/* Identities                                                          */
/* ================================================================== */

/** One arithmetic claim, with both sides and its delta. Never just a tick. */
export function IdentityRow({ identity, currency }: { identity: Identity; currency: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border-subtle py-1 text-2xs last:border-0">
      <code className="font-mono text-content-muted">{identity.identity}</code>
      <span className="font-mono tabular-nums">
        {money(identity.left, currency)}
        <span className="mx-1 text-content-subtle">vs</span>
        {money(identity.right, currency)}
        <Badge tone={identity.ok ? "success" : "danger"} size="xs" className="ml-2">
          {identity.ok ? "ok" : `off by ${money(identity.delta, currency)}`}
        </Badge>
      </span>
    </div>
  );
}

export function IdentityList({
  identities,
  currency,
  title,
}: {
  identities: readonly Identity[];
  currency: string;
  title: string;
}) {
  if (identities.length === 0) return null;
  const failing = identities.filter((i) => !i.ok);
  return (
    <Card>
      <CardBody>
        <div className="mb-1 flex items-center justify-between">
          <h3 className="text-sm font-semibold">{title}</h3>
          <Badge tone={failing.length === 0 ? "success" : "danger"} dot size="xs">
            {failing.length === 0
              ? `${identities.length} checked, all reconcile`
              : `${failing.length} of ${identities.length} fail`}
          </Badge>
        </div>
        {identities.map((identity) => (
          <IdentityRow key={identity.identity} identity={identity} currency={currency} />
        ))}
      </CardBody>
    </Card>
  );
}

/* ================================================================== */
/* Server refusals, rendered verbatim                                  */
/* ================================================================== */

export interface Refusal {
  status: number;
  /** the API's own sentence — printed as sent */
  message: string;
  control: string | null;
  /** SOV identity payload, when the refusal was the balance gate */
  sovTotal: number | null;
  contractSum: number | null;
  discrepancy: number | null;
  direction: string | null;
  currency: string | null;
  legs: Identity[];
  extra: Array<{ key: string; value: string }>;
}

const KNOWN_KEYS = new Set([
  "sovTotal",
  "contractSum",
  "discrepancy",
  "direction",
  "currency",
  "legs",
  "control",
]);

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function refusalFrom(err: unknown): Refusal {
  const base: Refusal = {
    status: 0,
    message: err instanceof Error ? err.message : "The request failed.",
    control: null,
    sovTotal: null,
    contractSum: null,
    discrepancy: null,
    direction: null,
    currency: null,
    legs: [],
    extra: [],
  };
  if (!(err instanceof ApiClientError)) return base;
  const body = err.details as { details?: unknown } | undefined;
  const detail =
    body && typeof body === "object" && body.details && typeof body.details === "object"
      ? (body.details as Record<string, unknown>)
      : {};
  return {
    ...base,
    status: err.status,
    message: err.message,
    control: typeof detail["control"] === "string" ? detail["control"] : null,
    sovTotal: num(detail["sovTotal"]),
    contractSum: num(detail["contractSum"]),
    discrepancy: num(detail["discrepancy"]),
    direction: typeof detail["direction"] === "string" ? detail["direction"] : null,
    currency: typeof detail["currency"] === "string" ? detail["currency"] : null,
    legs: Array.isArray(detail["legs"]) ? (detail["legs"] as Identity[]) : [],
    extra: Object.entries(detail)
      .filter(([k]) => !KNOWN_KEYS.has(k))
      .map(([key, value]) => ({
        key,
        value:
          typeof value === "string" || typeof value === "number" || typeof value === "boolean"
            ? String(value)
            : JSON.stringify(value),
      })),
  };
}

/**
 * The refusal, printed. When the balance gate fired, the identity legs come
 * with it — so the panel can say WHICH half of the schedule is wrong instead
 * of only that something is.
 */
export function RefusalPanel({
  refusal,
  onDismiss,
  title,
}: {
  refusal: Refusal | null;
  onDismiss?: () => void;
  title?: string;
}) {
  if (!refusal) return null;
  const segregation = refusal.control === "no_self_certification";
  const currency = refusal.currency ?? "USD";
  return (
    <Alert
      tone={segregation ? "warning" : "danger"}
      title={
        title ??
        (segregation
          ? "Segregation of duties — this control did its job"
          : refusal.discrepancy !== null
            ? "The schedule of values does not balance"
            : "The server refused this")
      }
      {...(onDismiss ? { onDismiss } : {})}
      className="mb-3"
    >
      <p className="whitespace-pre-wrap">{refusal.message}</p>
      {refusal.discrepancy !== null ? (
        <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-meta">
          <dt className="text-content-subtle">Σ schedule of values</dt>
          <dd className="font-mono tabular-nums">{money(refusal.sovTotal, currency)}</dd>
          <dt className="text-content-subtle">Contract sum</dt>
          <dd className="font-mono tabular-nums">{money(refusal.contractSum, currency)}</dd>
          <dt className="text-content-subtle">Discrepancy</dt>
          <dd className="font-mono tabular-nums">
            {money(refusal.discrepancy, currency)} ({refusal.direction})
          </dd>
        </dl>
      ) : null}
      {refusal.legs.length > 0 ? (
        <div className="mt-2">
          {refusal.legs.map((leg) => (
            <IdentityRow key={leg.identity} identity={leg} currency={currency} />
          ))}
        </div>
      ) : null}
      {refusal.extra.length > 0 ? (
        <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-2xs">
          {refusal.extra.map((e) => (
            <div key={e.key} className="contents">
              <dt className="font-medium">{e.key}</dt>
              <dd className="font-mono">{e.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {refusal.control ? (
        <p className="mt-1 text-2xs">
          Control: <code className="font-mono">{refusal.control}</code> · HTTP {refusal.status}
        </p>
      ) : null}
    </Alert>
  );
}

/** The identity, stated on screen whether or not anything is wrong with it. */
export function SovIdentityCard({
  sovTotal,
  contractSum,
  currency,
  ok,
  message,
  legs,
  drafted,
}: {
  sovTotal: number;
  contractSum: number;
  currency: string;
  ok: boolean;
  message?: string;
  legs?: readonly Identity[];
  drafted?: boolean;
}) {
  const delta = Number((sovTotal - contractSum).toFixed(2));
  return (
    <Card>
      <CardBody className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <code className="font-mono text-meta text-content-muted">
            Σ SOV lines = originalContractSum + approvedChangeSum
          </code>
          <Badge tone={ok ? "success" : "danger"} dot size="xs">
            {ok ? "Balances" : "Does not balance"}
          </Badge>
        </div>
        <div className="grid gap-3 text-meta sm:grid-cols-3">
          <figure>
            <figcaption className="text-content-subtle">Σ schedule of values</figcaption>
            <span className="font-mono text-base font-semibold tabular-nums">
              {money(sovTotal, currency)}
            </span>
            {drafted ? (
              <span className="block text-2xs text-content-subtle">
                including edits not yet saved
              </span>
            ) : null}
          </figure>
          <figure>
            <figcaption className="text-content-subtle">Contract sum</figcaption>
            <span className="font-mono text-base font-semibold tabular-nums">
              {money(contractSum, currency)}
            </span>
          </figure>
          <figure>
            <figcaption className="text-content-subtle">Discrepancy</figcaption>
            <span
              className={cx(
                "font-mono text-base font-semibold tabular-nums",
                ok ? "text-content" : "text-danger-fg",
              )}
            >
              {money(delta, currency)}
            </span>
          </figure>
        </div>
        {message ? <p className="text-2xs text-content-muted">{message}</p> : null}
        {legs && legs.length > 0 ? (
          <div>
            {legs.map((leg) => (
              <IdentityRow key={leg.identity} identity={leg} currency={currency} />
            ))}
          </div>
        ) : null}
      </CardBody>
    </Card>
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

export function useResource<T>(path: string | null): Loadable<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
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

export function useContracts(projectId: string | undefined): Loadable<Paginated<PrimeContract>> {
  return useResource<Paginated<PrimeContract>>(
    projectId ? `/api/v1/projects/${projectId}/prime-contracts?page=1&pageSize=100` : null,
  );
}

export function useContractSummary(projectId: string | undefined): Loadable<ContractSummary> {
  return useResource<ContractSummary>(
    projectId ? `/api/v1/projects/${projectId}/prime-contracts/summary` : null,
  );
}

export function useContract(contractId: string | null): Loadable<ContractView> {
  return useResource<ContractView>(contractId ? `/api/v1/prime-contracts/${contractId}` : null);
}

export function useSov(contractId: string | null): Loadable<SovView> {
  return useResource<SovView>(contractId ? `/api/v1/prime-contracts/${contractId}/sov` : null);
}

export function useChanges(contractId: string | null): Loadable<Paginated<PrimeChange>> {
  return useResource<Paginated<PrimeChange>>(
    contractId ? `/api/v1/prime-contracts/${contractId}/changes?page=1&pageSize=200` : null,
  );
}

export function useBillings(contractId: string | null): Loadable<Paginated<PaymentApplication>> {
  return useResource<Paginated<PaymentApplication>>(
    contractId ? `/api/v1/prime-contracts/${contractId}/billings?page=1&pageSize=200` : null,
  );
}

export function useBilling(
  contractId: string | null,
  billingId: string | null,
): Loadable<BillingView> {
  return useResource<BillingView>(
    contractId && billingId
      ? `/api/v1/prime-contracts/${contractId}/billings/${billingId}`
      : null,
  );
}

export function useVendors(): Loadable<Paginated<Vendor>> {
  return useResource<Paginated<Vendor>>("/api/v1/vendors?page=1&pageSize=200");
}

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
 * Collect a written reason before a controlled act — rejecting an application,
 * for instance, where the API requires one and the record keeps it.
 *
 * Not `window.prompt`: that is blocked outright in some embedding contexts,
 * and it cannot explain why the reason is being asked for or where it will end
 * up.
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

/** Vendors, indexed, so a party id can become a party name. */
export function useVendorNames(): (id: string | null) => string {
  const vendors = useVendors();
  const byId = useMemo(() => {
    const map = new Map<string, string>();
    for (const v of vendors.data?.items ?? []) map.set(v.id, v.name);
    return map;
  }, [vendors.data]);
  return useCallback(
    (id: string | null) => {
      if (!id) return "not recorded";
      return byId.get(id) ?? id;
    },
    [byId],
  );
}
