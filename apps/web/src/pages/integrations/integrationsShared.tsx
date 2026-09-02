/**
 * Shared types, helpers and disclosure primitives for the Integrations
 * workspace (spec Vol I §0.7 — webhooks #121, OAuth2 machine callers #120).
 *
 * The view-models mirror `apps/api/src/modules/integrations` exactly. Three
 * things this module exists to make impossible to bury:
 *
 *   · the signing key's CUSTODY — when the deployment falls back to
 *     AUTH_SECRET, the API's own note is rendered verbatim wherever an
 *     endpoint is created, listed or diagnosed;
 *   · a FINGERPRINT MISMATCH — the way an operator discovers that a master-key
 *     rotation silently broke an endpoint they still believe is working;
 *   · EGRESS — an outbound webhook carries record identifiers and hashes to an
 *     operator-nominated URL, and no allowlist restricts that URL.
 *
 * Secrets are shown exactly once. The reveal modal here follows the same
 * idiom as the ingestion API-token tab rather than inventing a second one.
 */
import { useState, type ReactNode } from "react";
import { useAuth } from "../../lib/auth";
import { ApiClientError } from "../../lib/api";
import { Button, Modal } from "../../ui";

/* ================================ Lists ================================== */

export interface ListResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Accept the platform's paginate() envelope or a bare array, so a contract
 * drift degrades to "everything on one page" rather than a blank screen.
 */
export function asList<T>(res: unknown): { items: T[]; total: number } {
  if (Array.isArray(res)) return { items: res as T[], total: res.length };
  if (res && typeof res === "object" && Array.isArray((res as { items?: unknown }).items)) {
    const r = res as { items: T[]; total?: number };
    return { items: r.items, total: typeof r.total === "number" ? r.total : r.items.length };
  }
  return { items: [], total: 0 };
}

/* ================================ Types ================================== */

/** dispatcher.keySource() — repeated on every signing contract the API sends. */
export interface KeySource {
  source: "WEBHOOK_SIGNING_KEY" | "AUTH_SECRET_FALLBACK" | string;
  sharedCustody: boolean;
  note: string;
}

/** The signing contract, echoed on create, read, test-ping and status. */
export interface SigningContract {
  algorithm: string;
  signatureVersion: string;
  headers: {
    signature: string;
    timestamp: string;
    delivery: string;
    event: string;
    endpoint: string;
    company: string;
    attempt: string;
  };
  stringToSign: string;
  signatureHeaderFormat: string;
  verify: string;
  keySource: KeySource;
}

/** webhook_endpoints row as the API views it (isActive boolean + fingerprint check). */
export interface EndpointView {
  id: string;
  companyId: string;
  name: string;
  url: string;
  eventKinds: string[];
  projectId: string | null;
  isActive: boolean;
  secretFingerprint: string;
  failureCount: number;
  disabledReason: string | null;
  lastDeliveryAt: string | null;
  lastStatus: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** false ⇒ the master key changed and the operator's saved secret is dead */
  secretFingerprintMatches: boolean;
}

/** POST /integrations/webhooks — the only response that ever carries the secret. */
export interface EndpointCreateResponse {
  endpoint: EndpointView;
  secret: string;
  secretWarning: string;
  signing: SigningContract;
  insecureTransport: string | null;
}

export interface EndpointDetailResponse {
  endpoint: EndpointView;
  deliveryCount: number;
  signing: SigningContract;
}

/** webhook_deliveries row. */
export interface DeliveryRow {
  id: string;
  companyId: string;
  endpointId: string;
  ledgerEntryId: string | null;
  eventKind: string;
  payload: Record<string, unknown>;
  signature: string;
  status: string; // pending | delivered | failed | exhausted | skipped
  attempts: number;
  nextAttemptAt: string | null;
  responseStatus: number | null;
  responseBody: string | null;
  error: string | null;
  deliveredAt: string | null;
  createdAt: string;
}

export interface TestPingResponse {
  delivery: DeliveryRow | null;
  signing: SigningContract;
}

export interface EmitterHealth {
  enqueueFailures: number;
  lastEnqueueError: string | null;
  lastEnqueueErrorAt: string | null;
  eventsSeen: number;
  deliveriesEnqueued: number;
}

export interface DeliveryTuning {
  maxAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  failureThreshold: number;
  responseBodyLimit: number;
  requestTimeoutMs: number;
  dispatchIntervalMs: number;
  mode: string;
}

/** GET /integrations/webhooks/status */
export interface WebhookStatusResponse {
  queue: Record<string, number>;
  emitter: EmitterHealth;
  signing: SigningContract;
  delivery: DeliveryTuning;
  env: Record<string, string | number>;
}

export interface EventCatalogueRow {
  eventKind: string;
  objectType: string;
  action: string;
  count: number;
  lastSeenAt: string | null;
}

/** GET /integrations/events — derived from THIS tenant's ledger, not curated. */
export interface EventCatalogue {
  events: EventCatalogueRow[];
  objectTypes: string[];
  actions: string[];
  wildcards: string[];
  derivedFrom: string;
  note: string;
}

/** oauth_clients row minus the secret hash, isActive as a boolean. */
export interface OauthClientView {
  id: string;
  companyId: string;
  name: string;
  clientId: string;
  scopes: string[];
  grantTypes: string[];
  tokenTtlSeconds: number;
  isActive: boolean;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** POST /integrations/oauth/clients — the only response carrying the secret. */
export interface ClientCreateResponse {
  client: OauthClientView;
  clientId: string;
  clientSecret: string;
  secretWarning: string;
  tokenEndpoint: string;
  grantType: string;
  example: string;
}

export interface OauthTokenRow {
  id: string;
  companyId: string;
  clientId: string;
  scopes: string[];
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  issuedAt: string;
}

/** POST /integrations/oauth/introspect — RFC 7662 shaped. */
export interface IntrospectResponse {
  active: boolean;
  scope?: string;
  client_id?: string;
  client_name?: string;
  token_type?: string;
  exp?: number;
  iat?: number;
  company_id?: string;
  last_used_at?: string | null;
  token_id?: string;
}

/** GET /integrations/oauth/scopes */
export interface ScopeCatalogue {
  tools: string[];
  levels: string[];
  format: string;
  examples: string[];
  note: string;
}

/** ingestion_sources row — connector sources live in the ingestion module. */
export interface SourceRow {
  id: string;
  companyId: string;
  projectId: string | null;
  name: string;
  kind: string; // csv | procore | aconex | api_token
  config: Record<string, unknown>;
  isActive: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectPick {
  id: string;
  name: string;
  number?: string | null;
}

/** The 501 body a connector pull returns when it is not configured. */
export interface ConnectorNotConfigured {
  connector: string;
  required: { credentials: string[]; config: string[] };
  missing: { env: string[]; config: string[] };
  env: string[];
  note: string;
}

/** A configured pull stages a run; nothing enters the record until commit. */
export interface ConnectorPullResult {
  runId: string;
  connector: string;
  dataset: string;
  fetched: number;
  staged: number;
  projectId: string | null;
  nextStep: string;
  provenanceNote: string;
}

/* =============================== Helpers ================================= */

export function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export function num(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n.toLocaleString();
}

export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** The API wraps AppError details as { statusCode, error, message, details }. */
export function errorDetails(err: unknown): unknown {
  if (!(err instanceof ApiClientError)) return null;
  const body = err.details;
  if (!body || typeof body !== "object") return null;
  return (body as { details?: unknown }).details ?? null;
}

export function errorStatus(err: unknown): number | null {
  return err instanceof ApiClientError ? err.status : null;
}

/** Owner/admin gates every mutation here — and, in this module, every read. */
export function useIsCompanyAdmin(): boolean {
  const { company } = useAuth();
  return company?.role === "owner" || company?.role === "admin";
}

export const ADMIN_ONLY_HINT =
  "Owner or admin role required. Integration surfaces configure credentials and outbound " +
  "egress, so the API gates them at company level.";

export function msDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  if (ms === 0) return "0 ms";
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s % 1 === 0 ? s : s.toFixed(1)} s`;
  const m = s / 60;
  if (m < 60) return `${m % 1 === 0 ? m : m.toFixed(1)} min`;
  return `${(m / 60).toFixed(1)} h`;
}

/**
 * The worst-case wall-clock window a delivery can occupy, from first attempt
 * to exhaustion, using the deployment's own tuning. It is the number a
 * receiver's freshness window has to cover — see the Signature reference.
 * Mirrors dispatcher.backoffMs() without its per-delivery jitter, then adds
 * the documented 20% jitter ceiling.
 */
export function retryBudgetMs(t: DeliveryTuning): number {
  let total = 0;
  for (let attempt = 1; attempt < Math.max(1, t.maxAttempts); attempt += 1) {
    const raw = t.backoffBaseMs * 2 ** (attempt - 1);
    const capped = Math.min(raw, t.backoffMaxMs);
    total += capped * 1.2;
  }
  // Every attempt can also burn its full request timeout before failing.
  total += Math.max(1, t.maxAttempts) * t.requestTimeoutMs;
  return Math.round(total);
}

/* --------------------------- event-kind grammar --------------------------- */

/** Mirrors events.ts SUBSCRIPTION_RE — the server rejects anything else. */
const SUBSCRIPTION_RE = /^(\*|(\*|[a-z0-9_]+)\.(\*|[a-z0-9_]+))$/;

export function isValidSubscription(value: string): boolean {
  return SUBSCRIPTION_RE.test(value.trim());
}

/** Mirrors events.ts matchesEventKind — an empty list means EVERY kind. */
export function matchesEventKind(subscriptions: string[], kind: string): boolean {
  if (subscriptions.length === 0) return true;
  const parts = kind.split(".");
  const objectType = parts[0] ?? "";
  const action = parts.slice(1).join(".");
  for (const raw of subscriptions) {
    const sub = raw.trim();
    if (sub === "" || sub === "*" || sub === "*.*") return true;
    if (sub === kind) return true;
    if (sub.endsWith(".*") && sub.slice(0, -2) === objectType) return true;
    if (sub.startsWith("*.") && sub.slice(2) === action) return true;
  }
  return false;
}

/* ================================ Tones ================================== */

export const DELIVERY_STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  delivered: "Delivered",
  failed: "Failed (will retry)",
  exhausted: "Exhausted",
  skipped: "Skipped",
};

export const DELIVERY_STATUSES = [
  "pending",
  "delivered",
  "failed",
  "exhausted",
  "skipped",
] as const;

export function deliveryTone(status: string): string {
  switch (status) {
    case "delivered":
      return "green";
    case "pending":
      return "blue";
    case "failed":
      return "amber";
    case "exhausted":
      return "red";
    default:
      return "gray"; // skipped
  }
}

export const SOURCE_KIND_LABELS: Record<string, string> = {
  csv: "CSV upload",
  procore: "Procore connector",
  aconex: "Aconex connector",
  api_token: "API token (machine push)",
};

export function sourceKindTone(kind: string): string {
  switch (kind) {
    case "csv":
      return "blue";
    case "api_token":
      return "violet";
    default:
      return "gray"; // procore | aconex — scaffolded, never exercised live
  }
}

/* ============================== Components =============================== */

export function TabBar({
  tabs,
  active,
  onSelect,
}: {
  tabs: { key: string; label: string }[];
  active: string;
  onSelect: (key: string) => void;
}) {
  return (
    <div className="mb-5 flex flex-wrap gap-1 border-b border-ink-200">
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          onClick={() => onSelect(t.key)}
          className={
            active === t.key
              ? "-mb-px border-b-2 border-brand-600 px-3 py-2 text-sm font-medium text-brand-700"
              : "-mb-px border-b-2 border-transparent px-3 py-2 text-sm font-medium text-ink-500 hover:text-ink-800"
          }
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** A caveat strip for disclosures that must not be missed. */
export function Caveat({
  children,
  tone = "amber",
}: {
  children: ReactNode;
  tone?: "amber" | "red" | "ink";
}) {
  const cls =
    tone === "red"
      ? "rounded-md bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-900 ring-1 ring-red-200"
      : tone === "ink"
        ? "rounded-md bg-ink-50 px-3 py-2 text-xs leading-relaxed text-ink-700 ring-1 ring-ink-200"
        : "rounded-md bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900 ring-1 ring-amber-200";
  return <div className={cls}>{children}</div>;
}

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="shrink-0 rounded border border-ink-200 px-2 py-0.5 text-xs text-ink-600 hover:bg-ink-50"
      onClick={() => {
        void navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => {
            window.alert(
              "Automatic copy was blocked by the browser — select the text and copy it manually.",
            );
          });
      }}
    >
      {copied ? "Copied" : (label ?? "Copy")}
    </button>
  );
}

/** Right-hand slide-over, the same idiom the rest of the product uses. */
export function Drawer({
  open,
  title,
  onClose,
  children,
  wide,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-ink-950/40">
      <div
        className={`h-full overflow-y-auto bg-white p-5 shadow-xl ${wide ? "w-full max-w-4xl" : "w-full max-w-lg"}`}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 className="text-base font-semibold text-ink-900">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-700"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function StatTile({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone?: "green" | "red" | "amber" | "blue" | "gray";
  hint?: string;
}) {
  const cls =
    tone === "green"
      ? "text-emerald-700"
      : tone === "red"
        ? "text-red-700"
        : tone === "amber"
          ? "text-amber-700"
          : tone === "blue"
            ? "text-brand-700"
            : "text-ink-900";
  return (
    <div className="rounded-md bg-ink-50 px-3 py-2">
      <div className={`text-lg font-semibold tabular-nums ${cls}`}>{value}</div>
      <div className="text-[11px] font-medium uppercase tracking-wide text-ink-400">{label}</div>
      {hint ? <div className="mt-0.5 text-[11px] leading-snug text-ink-400">{hint}</div> : null}
    </div>
  );
}

/** Label/value row used across the detail panels. */
export function DefRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[10rem_1fr] gap-3 border-b border-ink-50 py-1.5 text-sm last:border-0">
      <span className="text-xs font-medium uppercase tracking-wide text-ink-400">{label}</span>
      <div className="min-w-0 break-words text-ink-800">{children}</div>
    </div>
  );
}

export function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-xs text-ink-700">{children}</span>;
}

/* ------------------------- honesty: key custody -------------------------- */

/**
 * HONESTY RULE 2. When WEBHOOK_SIGNING_KEY is unset, every endpoint secret is
 * derived from AUTH_SECRET — the application's own JWT secret. Anyone who can
 * read that can forge a signature this platform's receivers would accept. The
 * API's note is rendered VERBATIM; nothing here paraphrases it away.
 */
export function SharedCustodyNotice({ keySource }: { keySource: KeySource | null | undefined }) {
  if (!keySource) return null;
  if (!keySource.sharedCustody) {
    return (
      <div className="rounded-md bg-emerald-50 px-3 py-2 text-xs leading-relaxed text-emerald-900 ring-1 ring-emerald-200">
        <span className="font-semibold">Signing key: {keySource.source}.</span>{" "}
        {keySource.note}
      </div>
    );
  }
  return (
    <div className="rounded-md bg-red-50 px-3 py-2.5 text-xs leading-relaxed text-red-900 ring-1 ring-red-200">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-sm font-semibold">
          Shared custody: webhook signatures are forgeable by anyone holding the JWT secret
        </span>
        <span className="rounded bg-red-100 px-1.5 py-0.5 font-mono text-[11px]">
          {keySource.source}
        </span>
      </div>
      <p className="mb-1.5">{keySource.note}</p>
      <p className="text-red-800">
        Consequence, stated plainly: a signature proves only that the sender held the derivation
        key. Under this fallback that is the same secret that signs every access token in the
        deployment, so a receiver verifying a signature is not verifying that ConstructOS sent
        it — only that <em>something with the application secret</em> did.
      </p>
    </div>
  );
}

/**
 * HONESTY RULE 3. secretFingerprintMatches goes false when the HKDF master key
 * changed after the endpoint was created: the secret the operator saved no
 * longer matches what the platform now signs with. The endpoint keeps
 * delivering — with a signature the receiver will reject.
 */
export function FingerprintWarning({ endpoint }: { endpoint: EndpointView }) {
  if (endpoint.secretFingerprintMatches) return null;
  return (
    <Caveat tone="red">
      <span className="font-semibold">
        The signing secret for this endpoint can no longer be reproduced.
      </span>{" "}
      The stored sha256 fingerprint does not match the secret derivable from the current master
      key, which means <strong>the master key was rotated</strong> (WEBHOOK_SIGNING_KEY was set,
      changed, or AUTH_SECRET moved) after this endpoint was created. Deliveries are still being
      signed — with a key the receiver does not hold, so every verification on their side now
      fails. Secrets are never re-issued: <strong>delete this endpoint and create a new one</strong>,
      then install the freshly shown secret at the receiver. Restoring the previous master key is
      the only other way back.
    </Caveat>
  );
}

/**
 * HONESTY RULE 5. Stated once, where endpoints are created.
 */
export function EgressNotice() {
  return (
    <Caveat tone="amber">
      <span className="font-semibold">This configures data egress out of the tenant boundary.</span>{" "}
      Every delivery carries the event kind, the object type and object id, the acting user id, the
      ledger sequence and the ledger payload/entry hashes to the URL you nominate — a host outside
      this platform's control. Endpoint URLs are <strong>not restricted to an allowlist</strong>:
      any http(s) URL is accepted, including internal addresses reachable from the API process.
      That is a known and documented gap in this deployment, not an oversight being hidden from
      you. Payload <em>bodies</em> are not sent — the envelope carries identifiers and hashes — but
      identifiers plus timing are themselves disclosure. Nominate the URL as deliberately as you
      would grant a user account.
    </Caveat>
  );
}

/* --------------------------- honesty: show-once --------------------------- */

/**
 * HONESTY RULE 1. Both the webhook signing secret and the OAuth client secret
 * exist in exactly one response at exactly one moment. This modal is the only
 * place either is ever rendered: warning verbatim from the API, a copy control,
 * and an explicit acknowledgement to dismiss. Same idiom as the ingestion
 * API-token reveal — deliberately not a second one.
 */
export function SecretRevealModal({
  open,
  title,
  warning,
  secretLabel,
  secret,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  /** the API's own secretWarning string — rendered verbatim */
  warning: string;
  secretLabel: string;
  secret: string;
  onClose: () => void;
  children?: ReactNode;
}) {
  const [ack, setAck] = useState(false);
  if (!open) return null;
  return (
    <Modal
      open={open}
      title={title}
      wide
      onClose={() => {
        if (
          window.confirm(
            "Close and discard the secret? It is not stored anywhere and will never be shown again.",
          )
        ) {
          setAck(false);
          onClose();
        }
      }}
    >
      <div className="space-y-4">
        <Caveat tone="red">
          <span className="font-semibold">
            This is the only time this secret will ever be shown.
          </span>{" "}
          {warning}
        </Caveat>

        <div>
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-500">
            {secretLabel}
          </div>
          <div className="flex items-center gap-2">
            <code className="block flex-1 select-all break-all rounded-md bg-ink-950 p-3 font-mono text-sm text-emerald-300">
              {secret}
            </code>
            <CopyButton text={secret} />
          </div>
        </div>

        {children}

        <label className="flex items-start gap-2 rounded-md bg-ink-50 p-3 text-sm text-ink-800">
          <input
            type="checkbox"
            checked={ack}
            onChange={(e) => setAck(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-ink-300 text-brand-600 focus:ring-brand-500"
          />
          <span>
            I have copied this secret into the receiving system's secret store. I understand it
            cannot be retrieved, re-sent or re-derived by anyone here, and that losing it means
            replacing this credential.
          </span>
        </label>

        <div className="flex justify-end">
          <Button
            disabled={!ack}
            title={ack ? undefined : "Acknowledge that the secret is stored before closing."}
            onClick={() => {
              setAck(false);
              onClose();
            }}
          >
            I have stored it — close
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------ code blocks ------------------------------- */

export function CodeBlock({ children, className }: { children: string; className?: string }) {
  return (
    <div className="relative">
      <pre
        className={`overflow-x-auto rounded-md bg-ink-950 p-3 text-xs leading-relaxed text-ink-100 ${className ?? ""}`}
      >
        {children}
      </pre>
      <div className="absolute right-2 top-2">
        <CopyButton text={children} />
      </div>
    </div>
  );
}

/** Verbatim JSON body — used wherever the server's own words are the authority. */
export function VerbatimBody({ body, label }: { body: unknown; label?: string }) {
  const text =
    body === null || body === undefined
      ? "(no body)"
      : typeof body === "string"
        ? body
        : JSON.stringify(body, null, 2);
  return (
    <div>
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-500">
        {label ?? "Response body, verbatim"}
      </div>
      <pre className="max-h-72 overflow-auto rounded-md bg-ink-950 p-3 text-xs leading-relaxed text-ink-100">
        {text}
      </pre>
    </div>
  );
}
