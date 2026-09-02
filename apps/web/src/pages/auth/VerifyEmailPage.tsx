/**
 * EMAIL VERIFICATION LANDING.
 *
 * The token in the link is consumed here, once. Everything about the outcome is
 * the server's — including the purpose the token was issued for (`signup`,
 * `email_change`, `reverify`), which is carried back so a consumed token cannot
 * quietly serve a different purpose than the one it was minted for.
 */
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Alert, Button, Field, Input } from "../../ui";
import { IconCheckCircle } from "../../ui/icons";
import { api } from "../../lib/api";
import { AuthLink, AuthShell, FailureAlert, useAuthAction } from "./authShared";

interface VerifyResult {
  verified: boolean;
  email: string;
  purpose: string;
}

const PURPOSE_LABEL: Record<string, string> = {
  signup: "This address is now confirmed on the account it was registered with.",
  email_change: "The address change on this account is now in force.",
  reverify: "This address has been re-confirmed.",
};

export default function VerifyEmailPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const action = useAuthAction();
  const [token, setToken] = useState(searchParams.get("token") ?? "");
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [attempted, setAttempted] = useState(false);

  useEffect(() => {
    const initial = searchParams.get("token");
    if (!initial || attempted) return;
    setAttempted(true);
    void action
      .run("verify", () => api.post<VerifyResult>("/api/v1/auth/verify-email", { token: initial }))
      .then((res) => {
        if (res) setResult(res);
      });
    // The token is consumed once; re-running on every render would burn it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempted]);

  if (result) {
    return (
      <AuthShell title="Address confirmed" subtitle={result.email}>
        <Alert tone="success" title="Verified" icon={IconCheckCircle}>
          {PURPOSE_LABEL[result.purpose] ?? "This address has been confirmed."}
        </Alert>
        <Button className="mt-4" fullWidth onClick={() => navigate("/", { replace: true })}>
          Continue
        </Button>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Confirm your email address"
      subtitle="Verification links work once and expire."
      footer={<AuthLink to="/login">Back to sign in</AuthLink>}
    >
      <FailureAlert
        failure={action.failure}
        title="This link could not be used"
        onDismiss={action.clear}
      />
      {action.busy === "verify" ? (
        <Alert tone="info" size="sm">
          Confirming…
        </Alert>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void action
              .run("verify", () =>
                api.post<VerifyResult>("/api/v1/auth/verify-email", { token: token.trim() }),
              )
              .then((res) => {
                if (res) setResult(res);
              });
          }}
        >
          <Field
            label="Verification token"
            hint="Paste it from the link if your mail client mangled the address."
          >
            <Input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              className="font-mono"
              autoFocus
            />
          </Field>
          <Button type="submit" fullWidth disabled={token.trim().length === 0}>
            Confirm
          </Button>
        </form>
      )}
      <p className="mt-4 text-2xs leading-snug text-content-subtle">
        If the link has expired, sign in and ask for a new one from your account security page —
        there is a limit on how often one can be sent.
      </p>
    </AuthShell>
  );
}
