/**
 * ACCOUNT SECURITY — the page an ISO 27001 or SOC 2 auditor asks to see, and
 * the one a user reaches for after a lost laptop.
 *
 * Four surfaces, each backed by a control the API enforces rather than
 * suggests:
 *
 *   Sessions      every live device, the one you are on marked, revoke singly
 *                 or everywhere. Expiry is swept lazily on THIS read — never by
 *                 a cron — and the page says what the sweep did.
 *   Two-factor    enrolment shows the otpauth URI as a QR THE CLIENT DRAWS: no
 *                 encoder ships in the API, deliberately, so the seed is never
 *                 rendered into a bitmap a server could cache or log. Recovery
 *                 codes get the show-once treatment. Disabling requires proof
 *                 of possession — a live session is not enough, because the
 *                 whole point of the factor is that a stolen session cannot
 *                 remove it.
 *   Sign-in       password and linked identities together, because the platform
 *                 refuses to let you remove the last way in.
 *   Activity      the account-security trail, deliberately separate from the
 *                 assurance ledger: that records what was done to PROJECT
 *                 records, this records what happened to this ACCOUNT.
 */
import { useEffect, useMemo, useState } from "react";
import {
  ActivityFeed,
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  DescriptionList,
  EmptyState,
  Field,
  Input,
  Modal,
  PageHeader,
  Skeleton,
  Tabs,
} from "../../ui";
import type { TimelineItem } from "../../ui";
import type { Tone } from "../../ui/tokens";
import { cx } from "../../ui/cx";
import {
  IconCheckCircle,
  IconGlobe,
  IconLock,
  IconSecurity,
  IconTrash,
  IconWarning,
} from "../../ui/icons";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import {
  FailureAlert,
  PolicyHint,
  QrCode,
  Reasons,
  ShowOnce,
  failureFrom,
  useAuthAction,
  usePasswordPolicy,
  type AuthFailure,
} from "./authShared";

/* ================================================================== */
/* Wire shapes                                                         */
/* ================================================================== */

interface SessionView {
  id: string;
  current: boolean;
  authMethod: string;
  companyId: string | null;
  deviceLabel: string | null;
  userAgent: string | null;
  ip: string | null;
  mfaSatisfiedAt: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

interface SessionsResponse {
  items: SessionView[];
  sweptExpired: number;
  currentSessionKnown: boolean;
}

interface MfaStatus {
  enrolled: boolean;
  status: string;
  method: string;
  label: string | null;
  confirmedAt: string | null;
  lastUsedAt: string | null;
  locked: boolean;
  lockedUntil: string | null;
  retryAfterSeconds: number;
  failedAttempts: number;
  /** null — never 0 — where no factor exists to count codes for */
  recoveryCodesRemaining: number | null;
  stepUp: { satisfied: boolean; at?: string | null };
  policy: { required: boolean; requiredBy: Array<{ companyId: string; name: string }> };
  reasons: string[];
}

interface EnrolResponse {
  mfaId: string;
  secret: string;
  otpauthUri: string;
  otpauth: { uri: string; secret: string; issuer: string; account: string };
  reasons: string[];
}

interface ConfirmResponse {
  status: string;
  confirmedAt: string;
  recoveryCodes: string[];
  recoveryCodesRemaining: number;
  warning: string;
}

interface LinkedIdentity {
  id: string;
  providerId: string;
  companyId: string | null;
  externalSubject: string;
  emailAtLink: string | null;
  displayName: string | null;
  linkedAt: string;
  lastLoginAt: string | null;
  providerSlug: string;
  providerKind: string;
  providerName: string;
}

interface IdentitiesResponse {
  items: LinkedIdentity[];
  signInMethods: {
    password: boolean;
    passwordReasons: string[];
    identities: number;
    total: number;
  };
}

interface VerificationResponse {
  email: string;
  verified: boolean;
  verifiedAt: string | null;
  pending: { expiresAt: string; sentAt: string } | null;
  resendsPerHour: number;
  policy: {
    enforced: boolean;
    unverifiedMay: string[];
    unverifiedMayNot: string[];
    note: string;
  };
}

interface SecurityEvent {
  id: string;
  kind: string;
  outcome: string;
  at: string;
  ip: string | null;
  userAgent: string | null;
  sessionId: string | null;
  companyId: string | null;
  reason: string | null;
  metadata: Record<string, unknown> | null;
}

/* ================================================================== */
/* Small hooks                                                         */
/* ================================================================== */

/**
 * One GET, re-run when `nonce` changes. A fetch belongs in an effect, not in a
 * render: React may render a component twice before committing, and a request
 * fired from the render body would go out twice with it.
 */
function useJson<T>(path: string | null, nonce: number): {
  data: T | null;
  loading: boolean;
  failure: AuthFailure | null;
} {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [failure, setFailure] = useState<AuthFailure | null>(null);

  useEffect(() => {
    if (path === null) {
      setData(null);
      setLoading(false);
      setFailure(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    api
      .get<T>(path, { signal: controller.signal })
      .then((res) => {
        if (controller.signal.aborted) return;
        setData(res);
        setFailure(null);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setFailure(failureFrom(err));
        setLoading(false);
      });
    return () => controller.abort();
  }, [path, nonce]);

  return { data, loading, failure };
}

const when = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
};

const titleCase = (v: string): string =>
  v
    .split(/[_\s]+/)
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");

/** A rough, honest device label — the user agent is all the server has. */
function deviceOf(session: SessionView): string {
  if (session.deviceLabel) return session.deviceLabel;
  const ua = session.userAgent ?? "";
  if (!ua) return "Unrecognised device";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Chrome\//.test(ua)
      ? "Chrome"
      : /Safari\//.test(ua) && !/Chrome/.test(ua)
        ? "Safari"
        : /Firefox\//.test(ua)
          ? "Firefox"
          : "Browser";
  const os = /Windows/.test(ua)
    ? "Windows"
    : /Mac OS X/.test(ua)
      ? "macOS"
      : /Android/.test(ua)
        ? "Android"
        : /iPhone|iPad/.test(ua)
          ? "iOS"
          : /Linux/.test(ua)
            ? "Linux"
            : "unknown OS";
  return `${browser} on ${os}`;
}

/* ================================================================== */
/* Page                                                                */
/* ================================================================== */

type TabKey = "sessions" | "mfa" | "methods" | "activity";

const TABS: Array<{ value: TabKey; label: string }> = [
  { value: "sessions", label: "Sessions & devices" },
  { value: "mfa", label: "Two-factor" },
  { value: "methods", label: "Sign-in methods" },
  { value: "activity", label: "Activity" },
];

export default function AccountSecurityPage() {
  const { user } = useAuth();
  const [tab, setTab] = useState<TabKey>("sessions");
  const [nonce, setNonce] = useState(0);
  const refresh = () => setNonce((n) => n + 1);

  const mfa = useJson<MfaStatus>("/api/v1/auth/mfa", nonce);
  const sessions = useJson<SessionsResponse>("/api/v1/account/sessions", nonce);

  return (
    <div>
      <PageHeader
        icon={IconSecurity}
        title="Account security"
        subtitle="Where you are signed in, what proves it is you, and everything that has happened to this account."
        meta={user ? <span>{user.email}</span> : null}
        tabs={
          <Tabs
            aria-label="Account security"
            items={TABS.map((t) => ({
              value: t.value,
              label: t.label,
              ...(t.value === "sessions" && sessions.data
                ? { count: sessions.data.items.length }
                : {}),
              ...(t.value === "mfa" && mfa.data && !mfa.data.enrolled && mfa.data.policy.required
                ? { count: 1, tone: "danger" as const }
                : {}),
            }))}
            value={tab}
            onChange={setTab}
          />
        }
      />

      {tab === "sessions" ? (
        <SessionsPanel data={sessions.data} loading={sessions.loading} onChanged={refresh} />
      ) : tab === "mfa" ? (
        <MfaPanel status={mfa.data} loading={mfa.loading} onChanged={refresh} />
      ) : tab === "methods" ? (
        <MethodsPanel nonce={nonce} onChanged={refresh} />
      ) : (
        <ActivityPanel nonce={nonce} />
      )}
    </div>
  );
}

/* ================================================================== */
/* Sessions                                                            */
/* ================================================================== */

function SessionsPanel({
  data,
  loading,
  onChanged,
}: {
  data: SessionsResponse | null;
  loading: boolean;
  onChanged: () => void;
}) {
  const action = useAuthAction();

  if (loading && !data) {
    return (
      <div className="space-y-2">
        <Skeleton height={72} radius="lg" />
        <Skeleton height={72} radius="lg" />
        <Skeleton height={72} radius="lg" />
      </div>
    );
  }
  if (!data) return null;

  async function revoke(session: SessionView) {
    const done = await action.run(`revoke:${session.id}`, () =>
      api.del(`/api/v1/account/sessions/${session.id}`),
    );
    if (done !== null) onChanged();
  }

  async function revokeOthers() {
    const done = await action.run("revoke-others", () =>
      api.post("/api/v1/account/sessions/revoke-others", {}),
    );
    if (done !== null) onChanged();
  }

  const others = data.items.filter((s) => !s.current).length;

  return (
    <div className="space-y-4">
      <FailureAlert failure={action.failure} onDismiss={action.clear} />

      {data.sweptExpired > 0 ? (
        <Alert tone="info" size="sm" title="Reading this list settled some expiries">
          {data.sweptExpired} session{data.sweptExpired === 1 ? "" : "s"} past their absolute
          lifetime were marked expired just now. Expiry is swept on the read, not by a scheduler —
          the read is the moment the answer has to be true.
        </Alert>
      ) : null}

      {!data.currentSessionKnown ? (
        <Alert tone="warning" size="sm" title="This device cannot be identified in the list">
          Your access token carries no session id, so &ldquo;this device&rdquo; cannot be marked.
          That happens with tokens minted by a sign-in path that predates session tracking. Signing
          out and back in will fix it.
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-meta leading-relaxed text-content-muted">
          Revoking a session kills its refresh token with it, so the device stops working at once
          rather than when its access token happens to expire.
        </p>
        <Button
          variant="secondary"
          onClick={() => void revokeOthers()}
          loading={action.busy === "revoke-others"}
          disabled={others === 0}
        >
          Sign out {others} other device{others === 1 ? "" : "s"}
        </Button>
      </div>

      {data.items.length === 0 ? (
        <EmptyState
          title="No live sessions are recorded"
          hint="Either every session has been revoked or expired, or this account signs in by a path that does not open a tracked session."
        />
      ) : (
        <ul className="space-y-2">
          {data.items.map((s) => (
            <li key={s.id}>
              <Card accent={s.current ? "success" : undefined}>
                <CardBody className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{deviceOf(s)}</span>
                      {s.current ? (
                        <Badge tone="success" size="xs" dot>
                          this device
                        </Badge>
                      ) : null}
                      <Badge tone="neutral" size="xs" variant="subtle">
                        {titleCase(s.authMethod)}
                      </Badge>
                      {s.mfaSatisfiedAt ? (
                        <Badge tone="info" size="xs" variant="subtle" icon={IconLock}>
                          second factor proved
                        </Badge>
                      ) : null}
                    </div>
                    <dl className="mt-1.5 grid gap-x-6 gap-y-0.5 text-2xs text-content-subtle sm:grid-cols-2">
                      <Row label="Last seen" value={when(s.lastSeenAt)} />
                      <Row label="Signed in" value={when(s.createdAt)} />
                      <Row label="IP" value={s.ip ?? "not recorded"} />
                      <Row label="Expires" value={when(s.expiresAt)} />
                    </dl>
                  </div>
                  <Button
                    size="sm"
                    variant={s.current ? "secondary" : "danger"}
                    icon={IconTrash}
                    loading={action.busy === `revoke:${s.id}`}
                    onClick={() => void revoke(s)}
                  >
                    {s.current ? "Sign out here" : "Revoke"}
                  </Button>
                </CardBody>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 sm:contents">
      <dt>{label}</dt>
      <dd className="font-medium text-content-muted">{value}</dd>
    </div>
  );
}

/* ================================================================== */
/* Two-factor                                                          */
/* ================================================================== */

function MfaPanel({
  status,
  loading,
  onChanged,
}: {
  status: MfaStatus | null;
  loading: boolean;
  onChanged: () => void;
}) {
  const action = useAuthAction();
  const [enrolment, setEnrolment] = useState<EnrolResponse | null>(null);
  const [code, setCode] = useState("");
  const [issued, setIssued] = useState<string[] | null>(null);
  const [disableOpen, setDisableOpen] = useState(false);
  const [regenOpen, setRegenOpen] = useState(false);
  const [proof, setProof] = useState("");

  if (loading && !status) {
    return (
      <div className="space-y-2">
        <Skeleton height={120} radius="lg" />
        <Skeleton height={72} radius="lg" />
      </div>
    );
  }
  if (!status) return null;

  async function startEnrol() {
    const res = await action.run("enrol", () =>
      api.post<EnrolResponse>("/api/v1/auth/mfa/enrol", {}),
    );
    if (res) setEnrolment(res);
  }

  async function confirmEnrol() {
    const res = await action.run("confirm", () =>
      api.post<ConfirmResponse>("/api/v1/auth/mfa/enrol/confirm", { code: code.trim() }),
    );
    if (res) {
      setEnrolment(null);
      setCode("");
      setIssued(res.recoveryCodes);
      onChanged();
    }
  }

  async function disable() {
    const body: Record<string, unknown> = {};
    if (proof.trim().length > 8) body["recoveryCode"] = proof.trim();
    else if (proof.trim()) body["code"] = proof.trim();
    const done = await action.run("disable", () => api.post("/api/v1/auth/mfa/disable", body));
    if (done !== null) {
      setDisableOpen(false);
      setProof("");
      onChanged();
    }
  }

  async function regenerate() {
    const body: Record<string, unknown> = {};
    if (proof.trim().length > 8) body["recoveryCode"] = proof.trim();
    else if (proof.trim()) body["code"] = proof.trim();
    const res = await action.run("regen", () =>
      api.post<ConfirmResponse>("/api/v1/auth/mfa/recovery-codes", body),
    );
    if (res) {
      setRegenOpen(false);
      setProof("");
      setIssued(res.recoveryCodes);
      onChanged();
    }
  }

  if (issued) {
    return (
      <Card>
        <CardBody className="max-w-2xl">
          <ShowOnce
            title="Your recovery codes — shown once"
            description="Each one signs you in a single time if you lose your authenticator. Every code issued before now has been revoked. The server keeps only their hashes, so nobody — including us — can read them back."
            values={issued}
            onAcknowledge={() => setIssued(null)}
          />
        </CardBody>
      </Card>
    );
  }

  const tone: Tone = status.enrolled
    ? "success"
    : status.policy.required
      ? "danger"
      : "warning";

  return (
    <div className="max-w-2xl space-y-4">
      <FailureAlert failure={action.failure} onDismiss={action.clear} />

      <Alert
        tone={tone}
        icon={status.enrolled ? IconCheckCircle : IconWarning}
        title={
          status.enrolled
            ? "A second factor is enrolled and active"
            : status.status === "pending"
              ? "Enrolment started but never confirmed"
              : "No second factor is enrolled"
        }
      >
        <Reasons reasons={status.reasons} />
        {status.policy.required ? (
          <p className="mt-1.5 text-meta">
            Required by {status.policy.requiredBy.map((r) => r.name).join(", ")}. Tenant policy
            outranks personal preference: a user who could switch this off would make &ldquo;this
            company requires MFA&rdquo; a suggestion.
          </p>
        ) : null}
      </Alert>

      {status.locked ? (
        <Alert tone="danger" size="sm" title="Locked out of the second factor">
          Too many failed attempts. Try again after {when(status.lockedUntil)} (
          {status.retryAfterSeconds} seconds).
        </Alert>
      ) : null}

      {status.enrolled ? (
        <Card>
          <CardBody className="space-y-3">
            <DescriptionList
              columns={2}
              size="sm"
              items={[
                { label: "Method", value: "Authenticator app (TOTP)" },
                { label: "Enrolled", value: when(status.confirmedAt) },
                { label: "Last used", value: when(status.lastUsedAt) },
                {
                  label: "Recovery codes left",
                  value:
                    status.recoveryCodesRemaining === null ? (
                      <span className="italic text-content-subtle">not available</span>
                    ) : (
                      String(status.recoveryCodesRemaining)
                    ),
                  hint:
                    status.recoveryCodesRemaining === 0
                      ? "Every code has been used or revoked. Generate a new set before you need one."
                      : undefined,
                  tone: status.recoveryCodesRemaining === 0 ? "danger" : undefined,
                },
              ]}
            />
            <div className="flex flex-wrap gap-2 border-t border-border pt-3">
              <Button size="sm" variant="secondary" onClick={() => setRegenOpen(true)}>
                Generate new recovery codes
              </Button>
              <Button
                size="sm"
                variant="danger"
                onClick={() => setDisableOpen(true)}
                disabled={status.policy.required}
              >
                Turn off the second factor
              </Button>
            </div>
            {status.policy.required ? (
              <p className="text-2xs text-content-subtle">
                Disabling is refused while a company you belong to requires it.
              </p>
            ) : null}
          </CardBody>
        </Card>
      ) : enrolment ? (
        <Card>
          <CardBody className="space-y-4">
            <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
              <div className="rounded-lg border border-border bg-surface-raised p-3">
                <QrCode value={enrolment.otpauthUri} size={188} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">Scan this with your authenticator app</p>
                <p className="mt-1 text-meta leading-relaxed text-content-muted">
                  The API returns the otpauth URI and nothing else — no bitmap. This picture is
                  drawn here, in this tab, so the seed is never rendered into an image a server
                  could cache or log.
                </p>
                <p className="mt-3 text-label uppercase text-content-subtle">
                  Or enter the setup key by hand
                </p>
                <code className="mt-1 block select-all break-all rounded-md bg-surface-sunken px-2 py-1.5 font-mono text-sm">
                  {enrolment.secret}
                </code>
                <p className="mt-1 text-2xs text-content-subtle">
                  {enrolment.otpauth.issuer} · {enrolment.otpauth.account} · 6 digits, 30 seconds.
                </p>
              </div>
            </div>

            <Reasons reasons={enrolment.reasons} />

            <div className="flex items-end gap-2 border-t border-border pt-3">
              <Field label="Six-digit code from the app" className="w-48">
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  inputMode="numeric"
                  maxLength={8}
                  autoComplete="one-time-code"
                  className="font-mono tracking-[0.3em]"
                />
              </Field>
              <Button
                onClick={() => void confirmEnrol()}
                loading={action.busy === "confirm"}
                disabled={code.trim().length < 6}
              >
                Confirm
              </Button>
              <Button variant="ghost" onClick={() => setEnrolment(null)}>
                Cancel
              </Button>
            </div>
          </CardBody>
        </Card>
      ) : (
        <Card>
          <CardBody className="space-y-3">
            <p className="text-meta leading-relaxed text-content-muted">
              An authenticator app generates a six-digit code that changes every thirty seconds.
              Passkeys and SMS are deliberately absent: the platform only offers a factor it can
              actually verify, and offering one it cannot check would be the security equivalent of
              fabricating a figure.
            </p>
            <Button onClick={() => void startEnrol()} loading={action.busy === "enrol"}>
              Set up an authenticator app
            </Button>
          </CardBody>
        </Card>
      )}

      <ProofModal
        open={disableOpen}
        title="Turn off the second factor"
        description="A password is not enough, and neither is this live session: the whole point of the factor is that a stolen session cannot remove it. Prove possession with a current code or a recovery code."
        confirmLabel="Turn it off"
        destructive
        value={proof}
        onChange={setProof}
        busy={action.busy === "disable"}
        onClose={() => {
          setDisableOpen(false);
          setProof("");
        }}
        onConfirm={() => void disable()}
      />

      <ProofModal
        open={regenOpen}
        title="Generate new recovery codes"
        description="Every code issued before now will be revoked immediately. Regeneration issues credentials, so it is gated the same way disabling is: proof of possession, never a bare session."
        confirmLabel="Generate"
        value={proof}
        onChange={setProof}
        busy={action.busy === "regen"}
        onClose={() => {
          setRegenOpen(false);
          setProof("");
        }}
        onConfirm={() => void regenerate()}
      />
    </div>
  );
}

function ProofModal({
  open,
  title,
  description,
  confirmLabel,
  destructive,
  value,
  onChange,
  busy,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  value: string;
  onChange: (v: string) => void;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      tone={destructive ? "danger" : undefined}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={destructive ? "danger" : "primary"}
            loading={busy}
            disabled={value.trim().length === 0}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <p className="text-meta leading-relaxed text-content-muted">{description}</p>
        <Field
          label="Authenticator code, or a recovery code"
          hint="Six digits from the app, or one of the codes you were given at enrolment."
        >
          <Input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            autoComplete="one-time-code"
            autoFocus
            className="font-mono"
          />
        </Field>
      </div>
    </Modal>
  );
}

/* ================================================================== */
/* Sign-in methods                                                     */
/* ================================================================== */

function MethodsPanel({ nonce, onChanged }: { nonce: number; onChanged: () => void }) {
  const identities = useJson<IdentitiesResponse>("/api/v1/auth/sso/identities", nonce);
  const verification = useJson<VerificationResponse>("/api/v1/account/verification", nonce);
  const action = useAuthAction();
  const policy = usePasswordPolicy();

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [signOutOthers, setSignOutOthers] = useState(true);
  const [changed, setChanged] = useState<{ sessionsRevoked: number } | null>(null);

  const mismatch = confirm.length > 0 && confirm !== next;

  async function changePassword() {
    const res = await action.run("password", () =>
      api.post<{ ok: boolean; sessionsRevoked: number }>("/api/v1/account/password", {
        currentPassword: current,
        newPassword: next,
        signOutOtherDevices: signOutOthers,
      }),
    );
    if (res) {
      setCurrent("");
      setNext("");
      setConfirm("");
      setChanged({ sessionsRevoked: res.sessionsRevoked });
      onChanged();
    }
  }

  async function unlink(identity: LinkedIdentity) {
    const done = await action.run(`unlink:${identity.id}`, () =>
      api.del(`/api/v1/auth/sso/identities/${identity.id}`),
    );
    if (done !== null) onChanged();
  }

  async function resendVerification() {
    const done = await action.run("resend", () =>
      api.post("/api/v1/account/verification/resend", {}),
    );
    if (done !== null) onChanged();
  }

  return (
    <div className="max-w-2xl space-y-4">
      <FailureAlert failure={action.failure} onDismiss={action.clear} />

      {/* ------------------------- email ------------------------- */}
      {verification.data ? (
        <Card>
          <CardBody className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-medium">{verification.data.email}</p>
                <p className="text-2xs text-content-subtle">
                  {verification.data.verified
                    ? `Confirmed ${when(verification.data.verifiedAt)}`
                    : verification.data.pending
                      ? `A link was sent ${when(verification.data.pending.sentAt)} and expires ${when(verification.data.pending.expiresAt)}.`
                      : "Not confirmed, and no link is outstanding."}
                </p>
              </div>
              {verification.data.verified ? (
                <Badge tone="success" size="sm" dot>
                  verified
                </Badge>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void resendVerification()}
                  loading={action.busy === "resend"}
                >
                  Send a new link
                </Button>
              )}
            </div>
            <p className="text-2xs leading-snug text-content-subtle">
              {verification.data.policy.note}
            </p>
            {!verification.data.verified ? (
              <div className="grid gap-2 sm:grid-cols-2">
                <Reasons
                  reasons={verification.data.policy.unverifiedMay}
                  heading="Unverified, you may"
                />
                <Reasons
                  reasons={verification.data.policy.unverifiedMayNot}
                  heading="But you may not"
                />
              </div>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      {/* ------------------------- identities ------------------------- */}
      <Card>
        <CardBody className="space-y-3">
          <div>
            <p className="text-sm font-semibold">Ways into this account</p>
            <p className="mt-0.5 text-meta text-content-muted">
              The platform refuses to remove the last one. Taking away your only sign-in method does
              not make the account more secure; it makes it unreachable.
            </p>
          </div>

          {identities.loading && !identities.data ? (
            <Skeleton height={64} radius="md" />
          ) : identities.data ? (
            <>
              <div
                className={cx(
                  "flex items-start justify-between gap-3 rounded-lg border p-3",
                  identities.data.signInMethods.password
                    ? "border-border bg-surface-raised"
                    : "border-border bg-surface-sunken",
                )}
              >
                <div className="min-w-0">
                  <p className="text-meta font-medium">Password</p>
                  <p className="mt-0.5 text-2xs text-content-subtle">
                    {identities.data.signInMethods.password
                      ? "Usable on this account."
                      : identities.data.signInMethods.passwordReasons.join(" ")}
                  </p>
                </div>
                <Badge
                  tone={identities.data.signInMethods.password ? "success" : "neutral"}
                  size="xs"
                >
                  {identities.data.signInMethods.password ? "active" : "unavailable"}
                </Badge>
              </div>

              {identities.data.items.map((identity) => (
                <div
                  key={identity.id}
                  className="flex items-start justify-between gap-3 rounded-lg border border-border bg-surface-raised p-3"
                >
                  <div className="min-w-0">
                    <p className="text-meta font-medium">
                      {identity.providerName}
                      <Badge tone="neutral" size="xs" className="ml-2">
                        {titleCase(identity.providerKind)}
                      </Badge>
                    </p>
                    <p className="mt-0.5 truncate text-2xs text-content-subtle">
                      {identity.emailAtLink ?? identity.externalSubject} · linked{" "}
                      {when(identity.linkedAt)}
                      {identity.lastLoginAt ? ` · last used ${when(identity.lastLoginAt)}` : ""}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={action.busy === `unlink:${identity.id}`}
                    onClick={() => void unlink(identity)}
                  >
                    Unlink
                  </Button>
                </div>
              ))}

              {identities.data.items.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border p-3">
                  <p className="text-meta text-content-muted">
                    No identity provider is linked to this account. Signing in with Google,
                    Microsoft or your company&rsquo;s own provider from the sign-in page links one
                    the first time it is used.
                  </p>
                </div>
              ) : null}

              <p className="text-2xs text-content-subtle">
                Unlinking also kills any session that provider authenticated: &ldquo;I removed that
                provider&rdquo; and &ldquo;it still has a live session on my account&rdquo; must not
                be true at the same time.
              </p>
            </>
          ) : null}
        </CardBody>
      </Card>

      {/* ------------------------- password ------------------------- */}
      <Card>
        <CardBody className="space-y-3">
          <p className="text-sm font-semibold">Change your password</p>
          {changed ? (
            <Alert tone="success" size="sm" title="Password changed">
              {changed.sessionsRevoked} other session
              {changed.sessionsRevoked === 1 ? " was" : "s were"} signed out.
            </Alert>
          ) : null}
          <Field label="Current password">
            <Input
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </Field>
          <Field label="New password">
            <Input
              type="password"
              autoComplete="new-password"
              minLength={policy?.minLength ?? 8}
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
            <PolicyHint policy={policy} />
          </Field>
          <Field
            label="Confirm new password"
            error={mismatch ? "The two passwords do not match." : null}
          >
            <Input
              type="password"
              autoComplete="new-password"
              value={confirm}
              invalid={mismatch}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </Field>
          <label className="flex items-start gap-2 text-meta">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={signOutOthers}
              onChange={(e) => setSignOutOthers(e.target.checked)}
            />
            <span>
              Sign out every other device. Leave this on unless you have a reason not to — a
              password change usually means &ldquo;and lock them out&rdquo;.
            </span>
          </label>
          <Button
            onClick={() => void changePassword()}
            loading={action.busy === "password"}
            disabled={mismatch || !current || !next}
          >
            Change password
          </Button>
        </CardBody>
      </Card>
    </div>
  );
}

/* ================================================================== */
/* Activity                                                            */
/* ================================================================== */

const EVENT_TONE: Record<string, Tone> = {
  success: "success",
  failure: "danger",
  blocked: "warning",
  pending: "info",
};

function ActivityPanel({ nonce }: { nonce: number }) {
  const events = useJson<{ items: SecurityEvent[] }>(
    "/api/v1/account/security-events?limit=100",
    nonce,
  );

  const items: TimelineItem[] = useMemo(
    () =>
      (events.data?.items ?? []).map((e) => ({
        id: e.id,
        title: titleCase(e.kind),
        timestamp: e.at,
        tone: EVENT_TONE[e.outcome] ?? "neutral",
        badge: (
          <Badge tone={EVENT_TONE[e.outcome] ?? "neutral"} size="xs" variant="subtle">
            {e.outcome}
          </Badge>
        ),
        description: (
          <>
            {e.reason ? <span className="block">{e.reason}</span> : null}
            <span className="block text-2xs text-content-subtle">
              {[e.ip ?? "no IP recorded", e.userAgent].filter(Boolean).join(" · ")}
            </span>
          </>
        ),
      })),
    [events.data],
  );

  if (events.loading && !events.data) {
    return (
      <div className="space-y-2">
        <Skeleton height={56} radius="md" />
        <Skeleton height={56} radius="md" />
        <Skeleton height={56} radius="md" />
      </div>
    );
  }

  return (
    <div className="max-w-3xl space-y-3">
      <Alert tone="neutral" variant="subtle" size="sm" icon={IconGlobe}>
        This trail is deliberately separate from the assurance ledger. The ledger records what was
        done to PROJECT records and is anchored for dispute use; this records what happened to this
        ACCOUNT, and is what a security auditor asks to see.
      </Alert>
      {items.length === 0 ? (
        <EmptyState
          title="Nothing has been recorded against this account yet"
          hint="Sign-ins, failures, password changes, MFA events and session revocations all land here. An empty trail on a new account is expected; an empty trail on an old one is worth asking about."
        />
      ) : (
        <ActivityFeed items={items} timeFormat="absolute" aria-label="Account security events" />
      )}
    </div>
  );
}
