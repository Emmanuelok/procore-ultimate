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
