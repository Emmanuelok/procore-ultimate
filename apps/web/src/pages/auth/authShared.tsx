/**
 * Shared machinery for the AUTHENTICATION screens.
 *
 * THE RULES THESE SCREENS KEEP
 *
 *  1. NEVER SHOW A SECRET TWICE. Recovery codes, a TOTP seed and a bidder
 *     token exist in exactly one response at exactly one moment. `<ShowOnce>`
 *     gives them the same treatment the ingestion API tokens get: a loud
 *     warning, a copy control, and an explicit acknowledgement before the panel
 *     can be dismissed. There is no route that will show them again, because
 *     only their hashes are kept.
 *
 *  2. NEVER LEAK WHETHER AN ACCOUNT EXISTS. The API answers an unknown address
 *     and a wrong password identically, and always accepts a password-reset
 *     request. These screens repeat the server's wording rather than
 *     "helpfully" saying no such user.
 *
 *  3. PRINT THE SERVER'S REASONS VERBATIM. Password policy, MFA policy, a
 *     refused unlink, an invitation that cannot be accepted — every one comes
 *     back with a `reasons` array written to be read by a person.
 *
 *  4. SAY WHAT IS NOT WIRED UP. Where a deployment has no mail transport the
 *     API says so and hands back the link; the screens show that rather than
 *     claiming an email was sent.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Alert, Badge, Button, Card, CardBody } from "../../ui";
import { cx } from "../../ui/cx";
import { IconCheck, IconCopy, IconLock, IconWarning } from "../../ui/icons";
import { ApiClientError, api } from "../../lib/api";
import { encodeQr, qrPath } from "./qr";

/* ================================================================== */
/* Errors                                                              */
/* ================================================================== */

export interface AuthFailure {
  status: number;
  message: string;
  /** the server's own sentences, printed unchanged */
  reasons: string[];
  /** a machine code the screen can branch on (mfa_required_by_policy, …) */
  code: string | null;
  retryAfterSeconds: number | null;
}

export function failureFrom(err: unknown): AuthFailure {
  if (!(err instanceof ApiClientError)) {
    return {
      status: 0,
      message:
        err instanceof Error
          ? err.message
          : "The request could not be completed. Check your connection and try again.",
      reasons: [],
      code: null,
      retryAfterSeconds: null,
    };
  }
  const body = err.details as { details?: unknown } | undefined;
  const detail =
    body && typeof body === "object" && body.details && typeof body.details === "object"
      ? (body.details as Record<string, unknown>)
      : {};
  const reasons = Array.isArray(detail["reasons"])
    ? (detail["reasons"] as unknown[]).map((r) => String(r))
    : Array.isArray(detail["errors"])
      ? (detail["errors"] as unknown[]).map((r) => String(r))
      : [];
  return {
    status: err.status,
    message: err.message,
    reasons,
    code: typeof detail["code"] === "string" ? detail["code"] : null,
    retryAfterSeconds:
      typeof detail["retryAfterSeconds"] === "number" ? detail["retryAfterSeconds"] : null,
  };
}

export function FailureAlert({
  failure,
  title,
  onDismiss,
}: {
  failure: AuthFailure | null;
  title?: string;
  onDismiss?: () => void;
}) {
  if (!failure) return null;
  return (
    <Alert
      tone="danger"
      title={title ?? "That did not work"}
      icon={IconWarning}
      onDismiss={onDismiss}
      size="sm"
      className="mb-4"
    >
      <p className="whitespace-pre-wrap">{failure.message}</p>
      {failure.reasons.length > 0 ? (
        <ul className="mt-1.5 list-disc space-y-0.5 pl-4">
          {failure.reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      ) : null}
      {failure.retryAfterSeconds !== null ? (
        <p className="mt-1.5 text-meta">Try again in {failure.retryAfterSeconds} seconds.</p>
      ) : null}
    </Alert>
  );
}

/** A `reasons` array, printed as the server wrote it. */
export function Reasons({
  reasons,
  heading,
  className,
}: {
  reasons: readonly string[];
  heading?: ReactNode;
  className?: string;
}) {
  if (reasons.length === 0) return null;
  return (
    <div className={cx("text-meta text-content-muted", className)}>
      {heading ? <p className="font-medium text-content">{heading}</p> : null}
      <ul className="mt-1 list-disc space-y-0.5 pl-4">
        {reasons.map((r, i) => (
          <li key={i}>{r}</li>
        ))}
      </ul>
    </div>
  );
}

/* ================================================================== */
/* Actions                                                             */
/* ================================================================== */

export function useAuthAction(): {
  busy: string | null;
  failure: AuthFailure | null;
  clear: () => void;
  run: <T>(key: string, fn: () => Promise<T>) => Promise<T | null>;
} {
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<AuthFailure | null>(null);
  const run = useCallback(async <T,>(key: string, fn: () => Promise<T>): Promise<T | null> => {
    setBusy(key);
    setFailure(null);
    try {
      return await fn();
    } catch (err) {
      setFailure(failureFrom(err));
      return null;
    } finally {
      setBusy(null);
    }
  }, []);
  return { busy, failure, clear: () => setFailure(null), run };
}

/* ================================================================== */
/* The shell                                                           */
/* ================================================================== */

/**
 * The unauthenticated page frame. Deliberately plain, theme-aware, and built
 * only from semantic tokens — this is the one screen in the product a user sees
 * before any preference of theirs has loaded.
 */
export function AuthShell({
  title,
  subtitle,
  children,
  footer,
  width = "sm",
  aside,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: "sm" | "md" | "lg";
  aside?: ReactNode;
}) {
  const max = width === "lg" ? "max-w-2xl" : width === "md" ? "max-w-lg" : "max-w-sm";
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-surface px-4 py-10">
      <div className={cx("w-full", max)}>
        <BrandMark />
        <Card elevated className="mt-6">
          <CardBody className="p-6">
            <h1 className="text-lg font-semibold text-content">{title}</h1>
            {subtitle ? (
              <p className="mt-1 text-meta leading-relaxed text-content-muted">{subtitle}</p>
            ) : null}
            <div className="mt-5">{children}</div>
          </CardBody>
        </Card>
        {aside ? <div className="mt-4">{aside}</div> : null}
        {footer ? (
          <div className="mt-5 text-center text-meta text-content-muted">{footer}</div>
        ) : null}
      </div>
    </div>
  );
}

export function BrandMark() {
  return (
    <div className="flex flex-col items-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent text-lg font-bold text-accent-fg shadow-sm">
        C
      </div>
      <p className="mt-3 text-base font-semibold text-content">ConstructOS</p>
      <p className="text-label uppercase text-content-subtle">Delivery + Assurance</p>
    </div>
  );
}

export function AuthLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="font-medium text-accent-text underline-offset-2 hover:underline">
      {children}
    </Link>
  );
}

/* ================================================================== */
/* Identity providers                                                  */
/* ================================================================== */

export interface DiscoveredProvider {
  id: string;
  slug: string;
  kind: "google" | "microsoft" | "oidc" | "saml";
  displayName: string;
  startUrl: string;
  status: "ready" | "unsupported";
  unsupportedReason: string | null;
}

export interface ProviderDiscovery {
  domain: string | null;
  providers: DiscoveredProvider[];
  passwordLoginAllowed: boolean;
  reasons: string[];
}

/**
 * Ask what an address's DOMAIN may use.
 *
 * The endpoint never reads the users table — the answer is a function of the
 * domain and the tenant configuration for it, so an address with an account and
 * one without produce byte-identical responses. Nothing here can become a
 * user-enumeration oracle, and nothing here should be presented as though it
 * could tell you whether the account exists.
 */
export async function discoverProviders(email: string): Promise<ProviderDiscovery> {
  return api.get<ProviderDiscovery>(
    `/api/v1/auth/sso/providers?email=${encodeURIComponent(email)}`,
  );
}

const GOOGLE_MARK = (
  <svg viewBox="0 0 18 18" className="h-4 w-4" aria-hidden focusable="false">
    <path
      fill="#4285F4"
      d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"
    />
    <path
      fill="#34A853"
      d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"
    />
    <path
      fill="#FBBC05"
      d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z"
    />
    <path
      fill="#EA4335"
      d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"
    />
  </svg>
);

const MICROSOFT_MARK = (
  <svg viewBox="0 0 18 18" className="h-4 w-4" aria-hidden focusable="false">
    <rect x="0" y="0" width="8.5" height="8.5" fill="#F25022" />
    <rect x="9.5" y="0" width="8.5" height="8.5" fill="#7FBA00" />
    <rect x="0" y="9.5" width="8.5" height="8.5" fill="#00A4EF" />
    <rect x="9.5" y="9.5" width="8.5" height="8.5" fill="#FFB900" />
  </svg>
);

/**
 * A first-class provider button. Google and Microsoft carry their own marks —
 * those are brand assets rather than theme colours, which is why they are the
 * one place in this workspace with literal hex in them.
 */
export function ProviderButton({
  provider,
  returnTo,
  disabled,
}: {
  provider: DiscoveredProvider;
  returnTo?: string;
  disabled?: boolean;
}) {
  const mark =
    provider.kind === "google"
      ? GOOGLE_MARK
      : provider.kind === "microsoft"
        ? MICROSOFT_MARK
        : null;
  const unsupported = provider.status !== "ready";
  const href = returnTo
    ? `${provider.startUrl}?returnTo=${encodeURIComponent(returnTo)}`
    : provider.startUrl;

  if (unsupported) {
    return (
      <div className="rounded-lg border border-border bg-surface-sunken px-3 py-2.5">
        <div className="flex items-center gap-2">
          {mark}
          <span className="text-sm font-medium text-content-subtle">
            Continue with {provider.displayName}
          </span>
          <Badge tone="neutral" size="xs" className="ml-auto">
            unavailable
          </Badge>
        </div>
        {provider.unsupportedReason ? (
          <p className="mt-1 text-2xs leading-snug text-content-subtle">
            {provider.unsupportedReason}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <a
      href={href}
      aria-disabled={disabled}
      className={cx(
        "flex w-full items-center justify-center gap-2.5 rounded-lg border border-border bg-surface-raised px-3 py-2.5",
        "text-sm font-medium text-content transition-colors",
        "hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        disabled ? "pointer-events-none opacity-50" : undefined,
      )}
    >
      {mark}
      <span>Continue with {provider.displayName}</span>
    </a>
  );
}

/* ================================================================== */
/* Show once                                                          */
/* ================================================================== */

/**
 * A secret shown exactly once, with an acknowledgement before it can be
 * dismissed — the same treatment the ingestion API tokens get, for the same
 * reason: the server keeps only a hash, so "I did not copy it" has no remedy
 * other than issuing a new one.
 */
export function ShowOnce({
  title,
  description,
  values,
  copyAll,
  acknowledgeLabel,
  onAcknowledge,
}: {
  title: string;
  description: ReactNode;
  values: readonly string[];
  copyAll?: string;
  acknowledgeLabel?: string;
  onAcknowledge: () => void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [copied, setCopied] = useState(false);

  const copy = () => {
    const text = copyAll ?? values.join("\n");
    navigator.clipboard
      ?.writeText(text)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };

  return (
    <div className="space-y-3">
      <Alert tone="danger" title={title} icon={IconLock}>
        <p className="whitespace-pre-wrap">{description}</p>
      </Alert>

      <div className="rounded-lg border border-border bg-surface-inverse p-3">
        <ul className="grid gap-1 sm:grid-cols-2">
          {values.map((v, i) => (
            <li
              key={`${v}-${i}`}
              className="select-all break-all font-mono text-sm text-surface-inverse-fg"
            >
              {v}
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          icon={copied ? IconCheck : IconCopy}
          onClick={copy}
          type="button"
        >
          {copied ? "Copied" : "Copy"}
        </Button>
        <span className="text-2xs text-content-subtle">
          {values.length} value{values.length === 1 ? "" : "s"} — this panel cannot be reopened.
        </span>
      </div>

      <label className="flex items-start gap-2 text-meta">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={acknowledged}
          onChange={(e) => setAcknowledged(e.target.checked)}
        />
        <span>
          {acknowledgeLabel ??
            "I have stored these somewhere safe. I understand they cannot be shown again."}
        </span>
      </label>

      <Button type="button" disabled={!acknowledged} onClick={onAcknowledge} fullWidth>
        Done
      </Button>
    </div>
  );
}

/* ================================================================== */
/* QR                                                                  */
/* ================================================================== */

/**
 * The otpauth URI as a QR the CLIENT renders.
 *
 * Deliberately dark-on-white in both themes. A scanner reading an inverted
 * symbol is a coin toss, and this is the one image in the product whose job is
 * to be machine-readable rather than to match the page.
 */
export function QrCode({
  value,
  size = 200,
  label,
}: {
  value: string;
  size?: number;
  label?: string;
}) {
  let matrix;
  try {
    matrix = encodeQr(value);
  } catch {
    return (
      <Alert tone="warning" size="sm" title="This code could not be drawn">
        The enrolment URI is longer than a QR symbol can carry at this error-correction level. Use
        the setup key below instead — it enrols exactly the same factor.
      </Alert>
    );
  }
  const quiet = 4;
  const total = matrix.size + quiet * 2;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${total} ${total}`}
      role="img"
      aria-label={label ?? "Two-factor enrolment QR code"}
      className="rounded-lg"
      shapeRendering="crispEdges"
    >
      <rect width={total} height={total} fill="#ffffff" />
      <g transform={`translate(${quiet} ${quiet})`} fill="#000000">
        <path d={qrPath(matrix)} />
      </g>
    </svg>
  );
}

/* ================================================================== */
/* Password policy                                                     */
/* ================================================================== */

export interface PasswordPolicy {
  minLength: number;
  maxLength: number;
  rules: string[];
}

export function usePasswordPolicy(): PasswordPolicy | null {
  const [policy, setPolicy] = useState<PasswordPolicy | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .get<PasswordPolicy>("/api/v1/account/password-policy")
      .then((p) => {
        if (!cancelled) setPolicy(p);
      })
      .catch(() => {
        /* the server enforces it either way; the hint is a courtesy */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return policy;
}

export function PolicyHint({ policy }: { policy: PasswordPolicy | null }) {
  if (!policy) return null;
  return (
    <ul className="mt-1 space-y-0.5 text-2xs text-content-subtle">
      {policy.rules.map((r, i) => (
        <li key={i}>{r}</li>
      ))}
    </ul>
  );
}

/* ================================================================== */
/* Transport honesty                                                   */
/* ================================================================== */

export interface TransportNote {
  configured: boolean;
  kind: string;
  reasons: string[];
}

/**
 * Whether this deployment can actually send the message it just composed.
 * `recorded` is the honest state: the message was written down and NOT
 * delivered. Reporting that as "sent" would make a link nobody receives look
 * successful.
 */
export function TransportAlert({
  transport,
  link,
  what,
}: {
  transport: TransportNote | null | undefined;
  link?: string | null;
  what: string;
}) {
  if (!transport || transport.configured) return null;
  return (
    <Alert tone="warning" size="sm" title="No mail transport is configured here" className="mt-3">
      <p>
        The {what} was composed and recorded, but nothing was delivered — this deployment has no way
        to send mail.
      </p>
      {transport.reasons.length > 0 ? <Reasons reasons={transport.reasons} className="mt-1" /> : null}
      {link ? (
        <p className="mt-2 break-all font-mono text-2xs">
          <a className="text-accent-text underline" href={link}>
            {link}
          </a>
        </p>
      ) : null}
    </Alert>
  );
}
