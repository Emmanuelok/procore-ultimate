/**
 * SET A NEW PASSWORD from a single-use reset link.
 *
 * Completing a reset signs every other device out. That is not a courtesy
 * setting — a password reset is the remedy for "somebody else has my
 * credentials", and leaving their session alive would defeat it. The page says
 * so before the button is pressed and reports how many sessions went.
 */
import { useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Alert, Button, Field, Input } from "../../ui";
import { api } from "../../lib/api";
import {
  AuthLink,
  AuthShell,
  FailureAlert,
  PolicyHint,
  useAuthAction,
  usePasswordPolicy,
} from "./authShared";

interface ResetResult {
  ok: boolean;
  email: string;
  sessionsRevoked: number;
  message: string;
}

export default function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const action = useAuthAction();
  const policy = usePasswordPolicy();

  const [token, setToken] = useState(searchParams.get("token") ?? "");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [done, setDone] = useState<ResetResult | null>(null);

  const mismatch = confirm.length > 0 && confirm !== password;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const res = await action.run("complete", () =>
      api.post<ResetResult>("/api/v1/auth/password-reset/complete", { token, password }),
    );
    if (res) setDone(res);
  }

  if (done) {
    return (
      <AuthShell title="Password changed" subtitle={done.email}>
        <Alert tone="success" title="Done">
          <p>{done.message}</p>
          <p className="mt-1 text-meta">
            {done.sessionsRevoked} other session
            {done.sessionsRevoked === 1 ? " was" : "s were"} signed out.
          </p>
        </Alert>
        <Button className="mt-4" fullWidth onClick={() => navigate("/login", { replace: true })}>
          Sign in
        </Button>
      </AuthShell>
    );
  }

  if (!token) {
    return (
      <AuthShell
        title="This link is incomplete"
        subtitle="A reset link carries a single-use token in its address. Paste the whole link, or request a new one."
        footer={<AuthLink to="/forgot-password">Request a new link</AuthLink>}
      >
        <Field label="Reset token">
          <Input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            className="font-mono"
            placeholder="Paste the token from the link"
          />
        </Field>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Choose a new password"
      subtitle="This link works once and expires shortly."
      footer={<AuthLink to="/login">Back to sign in</AuthLink>}
    >
      <FailureAlert failure={action.failure} onDismiss={action.clear} />
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="New password">
          <Input
            type="password"
            autoComplete="new-password"
            required
            autoFocus
            minLength={policy?.minLength ?? 8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
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
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            invalid={mismatch}
          />
        </Field>
        <Alert tone="info" size="sm">
          Completing this signs out every other device on the account. A reset is the remedy for
          somebody else holding your credentials; leaving their session alive would defeat it.
        </Alert>
        <Button
          type="submit"
          fullWidth
          loading={action.busy === "complete"}
          disabled={mismatch || password.length === 0}
        >
          Set the password
        </Button>
      </form>
    </AuthShell>
  );
}
