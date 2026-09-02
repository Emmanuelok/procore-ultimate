/**
 * FORGOTTEN PASSWORD.
 *
 * The endpoint ALWAYS answers 202 with the same body. Whether the address has
 * an account, whether it is locked, whether the request was throttled — none of
 * it is observable. The only thing the response reports is a property of the
 * SERVER: can this deployment send mail at all.
 *
 * So this page shows the server's own sentence and never adds a helpful "we
 * couldn't find that address", which is the whole enumeration hole the design
 * closes.
 */
import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { Alert, Button, Field, Input } from "../../ui";
import { IconMail } from "../../ui/icons";
import { api } from "../../lib/api";
import { AuthLink, AuthShell, FailureAlert, Reasons, useAuthAction } from "./authShared";

interface ResetAccepted {
  status: string;
  message: string;
  transport: { configured: boolean; kind: string; reasons: string[] };
}

export default function ForgotPasswordPage() {
  const [searchParams] = useSearchParams();
  const action = useAuthAction();
  const [email, setEmail] = useState(searchParams.get("email") ?? "");
  const [sent, setSent] = useState<ResetAccepted | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const res = await action.run("reset", () =>
      api.post<ResetAccepted>("/api/v1/auth/password-reset", {
        email: email.trim().toLowerCase(),
      }),
    );
    if (res) setSent(res);
  }

  if (sent) {
    return (
      <AuthShell
        title="Check your email"
        subtitle="The same answer is given to every address, which is deliberate."
        footer={<AuthLink to="/login">Back to sign in</AuthLink>}
      >
        <Alert tone="info" title="Request accepted" icon={IconMail}>
          <p>{sent.message}</p>
        </Alert>
        {!sent.transport.configured ? (
          <Alert
            tone="warning"
            size="sm"
            className="mt-3"
            title="No mail transport is configured here"
          >
            <p>
              This deployment cannot send mail, so nothing was delivered. The reset link exists on
              the server but has not reached anybody — ask an administrator, or configure a
              transport.
            </p>
            <Reasons reasons={sent.transport.reasons} className="mt-1.5" />
          </Alert>
        ) : null}
        <p className="mt-4 text-2xs leading-snug text-content-subtle">
          Nothing on this page tells you whether an account exists for that address. That is not an
          oversight: an endpoint that answered differently would be a list of everybody who works
          here.
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Reset your password"
      subtitle="We will send a single-use link that expires shortly."
      footer={<AuthLink to="/login">Back to sign in</AuthLink>}
    >
      <FailureAlert failure={action.failure} onDismiss={action.clear} />
      <form onSubmit={onSubmit} className="space-y-4">
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
        <Button type="submit" fullWidth loading={action.busy === "reset"}>
          Send the reset link
        </Button>
      </form>
    </AuthShell>
  );
}
