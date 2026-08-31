/**
 * SIGN IN — email first, then whatever that domain actually allows.
 *
 * The order matters and is not cosmetic. `GET /auth/sso/providers` answers a
 * question about the DOMAIN, never about the user: it does not read the users
 * table at all, so an address with an account and one without produce identical
 * responses in indistinguishable time. Asking for the email first therefore
 * costs nothing in disclosure and buys the right thing — a page that offers
 * Google, Microsoft or the company's own IdP where those exist, and says
 * plainly when password sign-in has been turned off for that tenant.
 *
 * Three steps live in this one screen because they are one act:
 *
 *   identify   the address, and the discovery it triggers
 *   password   only where the tenant still allows it
 *   challenge  the second factor — or, where policy demands one and the account
 *              has none, enrolling it without losing the sign-in
 */
import { useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Alert, Badge, Button, Divider, Field, Input } from "../../ui";
import { IconArrowLeft, IconLock, IconMail } from "../../ui/icons";
import { api, tokenStore } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import {
  AuthLink,
  AuthShell,
  FailureAlert,
  ProviderButton,
  QrCode,
  Reasons,
  ShowOnce,
  discoverProviders,
  useAuthAction,
  type ProviderDiscovery,
} from "./authShared";

interface SessionResponse {
  user: { id: string; email: string; name: string };
  accessToken: string;
  refreshToken: string;
  expiresIn?: number;
  sessionId?: string;
  mfa?: {
    status: string;
    recoveryCodes?: string[];
    recoveryCodesRemaining?: number;
    warning?: string;
  };
}

interface ChallengeResponse {
  mfaRequired: true;
  challengeToken: string;
  challengeId: string;
  scope: "verify" | "enrol";
  expiresAt: string;
  methods: Array<"totp" | "recovery_code">;
  enrolmentRequired: boolean;
  policy: { required: boolean; companies: Array<{ companyId: string; name: string }> };
  reasons: string[];
}

interface EnrolResponse {
  mfaId: string;
  secret: string;
  otpauthUri: string;
  otpauth: { uri: string; secret: string; issuer: string; account: string };
  reasons: string[];
}

type Step = "identify" | "password" | "challenge" | "recovery-codes";

export default function LoginPage() {
  const { reload } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const action = useAuthAction();

  const [step, setStep] = useState<Step>("identify");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [discovery, setDiscovery] = useState<ProviderDiscovery | null>(null);

  const [challenge, setChallenge] = useState<ChallengeResponse | null>(null);
  const [code, setCode] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [enrolment, setEnrolment] = useState<EnrolResponse | null>(null);
  const [issuedCodes, setIssuedCodes] = useState<string[]>([]);

  const returnTo = searchParams.get("returnTo") ?? undefined;

  async function land() {
    await reload();
    navigate(returnTo && returnTo.startsWith("/") ? returnTo : "/", { replace: true });
  }

  /* ---------------------------------------------------------------- */
  /* Step 1 — identify                                                 */
  /* ---------------------------------------------------------------- */

  async function onIdentify(e: FormEvent) {
    e.preventDefault();
    const result = await action.run("discover", async () => {
      try {
        return await discoverProviders(email.trim().toLowerCase());
      } catch {
        // Discovery is an optimisation, not a gate. A deployment without the
        // SSO module still has to be able to sign in with a password.
        return {
          domain: null,
          providers: [],
          passwordLoginAllowed: true,
          reasons: [],
        } satisfies ProviderDiscovery;
      }
    });
    if (result) {
      setDiscovery(result);
      setStep("password");
    }
  }

  /* ---------------------------------------------------------------- */
  /* Step 2 — password                                                 */
  /* ---------------------------------------------------------------- */

  async function onPassword(e: FormEvent) {
    e.preventDefault();
    const result = await action.run("signin", async () => {
      try {
        return await api.post<SessionResponse | ChallengeResponse>("/api/v1/auth/mfa/login", {
          email: email.trim().toLowerCase(),
          password,
        });
      } catch (err) {
        // Where the MFA module is not mounted, fall back to the plain login the
        // identity module has always exposed.
        if (err && typeof err === "object" && "status" in err && (err as { status: number }).status === 404) {
          return await api.post<SessionResponse>("/api/v1/auth/login", {
            email: email.trim().toLowerCase(),
            password,
          });
        }
        throw err;
      }
    });
    if (!result) return;

    if ("mfaRequired" in result && result.mfaRequired) {
      setChallenge(result);
      setStep("challenge");
      if (result.scope === "enrol") {
        const provisioned = await action.run("enrol", () =>
          api.post<EnrolResponse>("/api/v1/auth/mfa/challenge/enrol", {
            challengeToken: result.challengeToken,
          }),
        );
        if (provisioned) setEnrolment(provisioned);
      }
      return;
    }

    tokenStore.set(result as SessionResponse);
    await land();
  }

  /* ---------------------------------------------------------------- */
  /* Step 3 — the second factor                                        */
  /* ---------------------------------------------------------------- */

  async function onChallenge(e: FormEvent) {
    e.preventDefault();
    if (!challenge) return;
    const body: Record<string, unknown> = { challengeToken: challenge.challengeToken };
    if (useRecovery) body["recoveryCode"] = recoveryCode.trim();
    else body["code"] = code.trim();
    const result = await action.run("challenge", () =>
      api.post<SessionResponse>("/api/v1/auth/mfa/challenge", body),
    );
    if (!result) return;
    tokenStore.set(result);
    const codes = result.mfa?.recoveryCodes ?? [];
    if (codes.length > 0) {
      setIssuedCodes(codes);
      setStep("recovery-codes");
      return;
    }
    await land();
  }

  /* ---------------------------------------------------------------- */

  if (step === "recovery-codes") {
    return (
      <AuthShell
        title="Your recovery codes"
        subtitle="You are signed in. Before you go anywhere, take these."
        width="md"
      >
        <ShowOnce
          title="These are shown once and cannot be retrieved again"
          description="Each code signs you in once if you lose your authenticator. The server keeps only their hashes — nobody, including us, can read them back. Losing them means generating a new set, which revokes every one of these."
          values={issuedCodes}
          onAcknowledge={() => void land()}
        />
      </AuthShell>
    );
  }

  if (step === "challenge" && challenge) {
    const enrolling = challenge.scope === "enrol";
    return (
      <AuthShell
        title={enrolling ? "Set up your second factor" : "Two-factor verification"}
        subtitle={
          enrolling
            ? "Your password was accepted. Your organisation requires a second factor and this account has none, so enrol one now — you will finish signing in in the same step."
            : "Your password was accepted. There is no session yet: it exists only once the second factor is proved."
        }
        width={enrolling ? "md" : "sm"}
        footer={
          <button
            type="button"
            className="inline-flex items-center gap-1 text-meta text-content-muted hover:text-content"
            onClick={() => {
              setStep("password");
              setChallenge(null);
              setEnrolment(null);
              setCode("");
              setRecoveryCode("");
            }}
          >
            <IconArrowLeft className="h-3.5 w-3.5" aria-hidden />
            Start again
          </button>
        }
      >
        <FailureAlert failure={action.failure} onDismiss={action.clear} />

        {challenge.reasons.length > 0 ? (
          <Reasons reasons={challenge.reasons} className="mb-4" />
        ) : null}

        {challenge.policy.required && challenge.policy.companies.length > 0 ? (
          <Alert tone="info" size="sm" className="mb-4" title="Required by your organisation">
            {challenge.policy.companies.map((c) => c.name).join(", ")} require a second factor for
            every member. This is not a preference you can switch off.
          </Alert>
        ) : null}

        {enrolling ? (
          enrolment ? (
            <div className="mb-5 space-y-3">
              <div className="flex justify-center rounded-lg border border-border bg-surface-raised p-4">
                <QrCode value={enrolment.otpauthUri} size={196} />
              </div>
              <div>
                <p className="text-label uppercase text-content-subtle">
                  Or type the setup key in by hand
                </p>
                <code className="mt-1 block select-all break-all rounded-md bg-surface-sunken px-2 py-1.5 font-mono text-sm">
                  {enrolment.secret}
                </code>
                <p className="mt-1 text-2xs text-content-subtle">
                  {enrolment.otpauth.issuer} · {enrolment.otpauth.account} · TOTP, 6 digits, 30
                  seconds. This seed leaves the platform exactly once — here.
                </p>
              </div>
            </div>
          ) : (
            <Alert tone="info" size="sm" className="mb-4">
              Provisioning a seed…
            </Alert>
          )
        ) : null}

        <form onSubmit={onChallenge} className="space-y-4">
          {useRecovery ? (
            <Field
              label="Recovery code"
              required
              hint="One of the codes you were given at enrolment. Each one works once."
            >
              <Input
                value={recoveryCode}
                onChange={(e) => setRecoveryCode(e.target.value)}
                autoComplete="one-time-code"
                autoFocus
                className="font-mono"
              />
            </Field>
          ) : (
            <Field
              label="Six-digit code"
              required
              hint={
                enrolling
                  ? "From the authenticator app you just added the seed to."
                  : "From your authenticator app."
              }
            >
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={8}
                autoFocus
                className="font-mono tracking-[0.3em]"
              />
            </Field>
          )}

          <Button
            type="submit"
            fullWidth
            loading={action.busy === "challenge"}
            disabled={enrolling && !enrolment}
          >
            {enrolling ? "Confirm and finish signing in" : "Verify"}
          </Button>
        </form>

        {challenge.methods.includes("recovery_code") ? (
          <button
            type="button"
            className="mt-3 w-full text-center text-meta text-content-muted hover:text-content"
            onClick={() => setUseRecovery((v) => !v)}
          >
            {useRecovery ? "Use an authenticator code instead" : "Use a recovery code instead"}
          </button>
        ) : null}

        <p className="mt-4 text-2xs text-content-subtle">
          This challenge expires at {new Date(challenge.expiresAt).toLocaleTimeString()}.
        </p>
      </AuthShell>
    );
  }

  if (step === "password" && discovery) {
    const ready = discovery.providers.filter((p) => p.status === "ready");
    const blocked = discovery.providers.filter((p) => p.status !== "ready");
    return (
      <AuthShell
        title="Sign in"
        subtitle={
          <>
            as <span className="font-medium text-content">{email.trim().toLowerCase()}</span>
            {discovery.domain ? (
              <>
                {" "}
                <Badge tone="neutral" size="xs">
                  {discovery.domain}
                </Badge>
              </>
            ) : null}
          </>
        }
        footer={
          <div className="space-y-2">
            <button
              type="button"
              className="inline-flex items-center gap-1 text-meta text-content-muted hover:text-content"
              onClick={() => {
                setStep("identify");
                setPassword("");
                action.clear();
              }}
            >
              <IconArrowLeft className="h-3.5 w-3.5" aria-hidden />
              Use a different address
            </button>
            <p>
              New to ConstructOS? <AuthLink to="/register">Create an account</AuthLink>
            </p>
          </div>
        }
      >
        <FailureAlert failure={action.failure} title="Sign-in refused" onDismiss={action.clear} />

        {ready.length > 0 ? (
          <div className="space-y-2">
            {ready.map((p) => (
              <ProviderButton key={p.id} provider={p} returnTo={returnTo} />
            ))}
          </div>
        ) : null}

        {blocked.length > 0 ? (
          <div className="mt-2 space-y-2">
            {blocked.map((p) => (
              <ProviderButton key={p.id} provider={p} />
            ))}
          </div>
        ) : null}

        {ready.length > 0 && discovery.passwordLoginAllowed ? (
          <Divider label="or" className="my-5" />
        ) : null}

        {discovery.passwordLoginAllowed ? (
          <form onSubmit={onPassword} className="space-y-4">
            <Field label="Password">
              <Input
                type="password"
                autoComplete="current-password"
                required
                autoFocus={ready.length === 0}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
              />
            </Field>
            <Button type="submit" fullWidth loading={action.busy === "signin"}>
              Sign in
            </Button>
          </form>
        ) : (
          <Alert tone="info" title="Password sign-in is off for this domain" icon={IconLock}>
            <p>
              Every SSO connection configured for {discovery.domain ?? "this domain"} requires
              single sign-on, so there is no password to type. Use one of the buttons above.
            </p>
            <Reasons reasons={discovery.reasons} className="mt-1.5" />
          </Alert>
        )}

        {discovery.passwordLoginAllowed ? (
          <p className="mt-4 text-center text-meta">
            <AuthLink to={`/forgot-password?email=${encodeURIComponent(email.trim())}`}>
              Forgotten your password?
            </AuthLink>
          </p>
        ) : null}

        {ready.length === 0 && discovery.reasons.length > 0 ? (
          <Reasons
            reasons={discovery.reasons}
            heading="About single sign-on for this domain"
            className="mt-4"
          />
        ) : null}
      </AuthShell>
    );
  }

  /* ---------------------------------------------------------------- */
  /* Step 0 — the address                                              */
  /* ---------------------------------------------------------------- */

  return (
    <AuthShell
      title="Sign in"
      subtitle="Start with your work email. We will offer whatever your organisation allows for that domain — single sign-on, a password, or both."
      footer={
        <p>
          New to ConstructOS? <AuthLink to="/register">Create an account</AuthLink>
        </p>
      }
    >
      <FailureAlert failure={action.failure} onDismiss={action.clear} />
      <form onSubmit={onIdentify} className="space-y-4">
        <Field label="Work email">
          <Input
            type="email"
            autoComplete="username email"
            required
            autoFocus
            leading={IconMail}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
          />
        </Field>
        <Button type="submit" fullWidth loading={action.busy === "discover"}>
          Continue
        </Button>
      </form>
      <p className="mt-4 text-2xs leading-snug text-content-subtle">
        Asking for the address first tells us nothing about you: the lookup reads only the domain
        and this company&rsquo;s own configuration for it, never the account list.
      </p>
    </AuthShell>
  );
}
