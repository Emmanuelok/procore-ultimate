/**
 * THE SSO LANDING.
 *
 * The API's callback never puts a refresh token in a URL — it would be written
 * to browser history, to the Referer header of the next request, and to every
 * proxy log in between. Instead the browser is redirected here with a
 * single-use ticket, valid for two minutes, which this page swaps for the
 * session over POST.
 *
 * Where the sign-in failed the callback redirects here with `error` and
 * `message` instead, and the message is the identity provider's or the
 * platform's own words — printed, not summarised.
 */
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Alert, Button } from "../../ui";
import { api, tokenStore } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { AuthLink, AuthShell, FailureAlert, useAuthAction } from "./authShared";

interface TicketPayload {
  user?: { id: string; email: string; name: string };
  accessToken?: string;
  refreshToken?: string;
  returnTo?: string | null;
  linked?: boolean;
  provisioned?: boolean;
  emailVerifiedByProvider?: boolean;
  identity?: { id: string; displayName: string; providerKind: string; emailAtLink: string | null };
  /** the tenant demands a second factor and the IdP did not provide one */
  mfaRequired?: boolean;
  challengeToken?: string;
  scope?: "verify" | "enrol";
  reasons?: string[];
}

export default function SsoCompletePage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { reload } = useAuth();
  const action = useAuthAction();
  const [attempted, setAttempted] = useState(false);
  const [payload, setPayload] = useState<TicketPayload | null>(null);

  const ticket = searchParams.get("ticket");
  const error = searchParams.get("error");
  const message = searchParams.get("message");
  const returnTo = searchParams.get("returnTo");
  // Set only for an unexpected server-side failure: the message in the URL is
  // then generic and this names the log line that has the detail.
  const reference = searchParams.get("reference");

  useEffect(() => {
    if (!ticket || attempted) return;
    setAttempted(true);
    void action
      .run("ticket", () => api.post<TicketPayload>("/api/v1/auth/sso/ticket", { ticket }))
      .then(async (res) => {
        if (!res) return;
        setPayload(res);
        if (res.accessToken && res.refreshToken) {
          tokenStore.set({ accessToken: res.accessToken, refreshToken: res.refreshToken });
          await reload();
          const target = res.returnTo ?? returnTo;
          navigate(target && target.startsWith("/") ? target : "/", { replace: true });
          return;
        }
        // A LINK, not a sign-in. `completeLink` returns { linked, identity,
        // returnTo } and no tokens — which this page used to report as "the
        // exchange succeeded but carried no tokens", i.e. it told the user
        // their successful link had failed.
        if (res.linked) {
          const target = res.returnTo ?? returnTo ?? "/account/security";
          navigate(target.startsWith("/") ? target : "/account/security", {
            replace: true,
            state: { linkedProvider: res.identity?.displayName ?? "the identity provider" },
          });
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempted, ticket]);

  if (error) {
    return (
      <AuthShell
        title="Single sign-on did not complete"
        subtitle="Nothing was signed in."
        footer={<AuthLink to="/login">Back to sign in</AuthLink>}
      >
        <Alert tone="danger" title={`Refused (HTTP ${error})`}>
          <p className="whitespace-pre-wrap">
            {message ?? "The identity provider did not return a usable assertion."}
          </p>
          {reference ? (
            <p className="mt-2 text-2xs">
              Reference <code className="select-all font-mono">{reference}</code> — quote it to your
              administrator; the detail is in the server log, deliberately not in this URL.
            </p>
          ) : null}
        </Alert>
        <p className="mt-4 text-2xs leading-snug text-content-subtle">
          A sign-in this server did not start, a state parameter that has already been spent, or an
          expired one all get exactly this answer. Start again from the sign-in page rather than
          reloading — the link is single-use.
        </p>
      </AuthShell>
    );
  }

  if (!ticket) {
    return (
      <AuthShell
        title="Nothing to complete"
        subtitle="This page is the landing point for a single sign-on redirect and carries no ticket."
        footer={<AuthLink to="/login">Back to sign in</AuthLink>}
      >
        <Alert tone="neutral" size="sm">
          Tickets are single-use and expire in two minutes. Start the sign-in again.
        </Alert>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Completing sign-in" subtitle="Exchanging the single-use ticket.">
      <FailureAlert
        failure={action.failure}
        title="The ticket could not be exchanged"
        onDismiss={action.clear}
      />
      {action.failure ? (
        <Button className="mt-2" fullWidth onClick={() => navigate("/login", { replace: true })}>
          Start again
        </Button>
      ) : payload?.mfaRequired ? (
        // The tenant requires a second factor and this connection did not
        // provide one. The challenge is redeemed on the sign-in page, which
        // already implements the whole enrol/verify flow.
        <div className="space-y-3">
          <Alert tone="info" title="One more step">
            <p>Your organisation requires a second factor before this sign-in can finish.</p>
          </Alert>
          {payload.reasons?.length ? (
            <ul className="list-disc space-y-1 pl-4 text-2xs text-content-subtle">
              {payload.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          ) : null}
          <Button fullWidth onClick={() => navigate("/login", { replace: true })}>
            Continue on the sign-in page
          </Button>
        </div>
      ) : payload?.linked ? (
        <Alert tone="success" title="Provider linked">
          {payload.identity?.displayName ?? "That identity provider"} is now a way into this
          account. Taking you back to your security settings.
        </Alert>
      ) : payload && !payload.accessToken ? (
        <Alert tone="warning" title="No session came back">
          The exchange succeeded but carried no tokens. Start the sign-in again.
        </Alert>
      ) : (
        <div className="space-y-2">
          <div className="h-4 w-2/3 animate-pulse rounded bg-surface-sunken" />
          <div className="h-4 w-1/2 animate-pulse rounded bg-surface-sunken" />
        </div>
      )}
    </AuthShell>
  );
}
