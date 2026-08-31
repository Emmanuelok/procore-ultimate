/**
 * CREATE AN ACCOUNT — and, optionally, the company workspace around it.
 *
 * Two honesty points the API insists on and this page repeats:
 *
 *  - The PASSWORD POLICY is published (`GET /account/password-policy`) so the
 *    form can state it before asking, and a refusal comes back as a `reasons`
 *    array written for a person. Neither is paraphrased here.
 *  - The VERIFICATION MESSAGE may not have been sent. Where a deployment has no
 *    mail transport the API composes and RECORDS the message and hands the link
 *    back in the response, to the person who just typed the address and nobody
 *    else. Showing "check your inbox" in that case would be a lie, so the page
 *    shows the link and says why.
 */
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Alert, Button, Field, Input } from "../../ui";
import { api, tokenStore } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import {
  AuthLink,
  AuthShell,
  FailureAlert,
  PolicyHint,
  useAuthAction,
  usePasswordPolicy,
} from "./authShared";

interface RegisterResponse {
  user: { id: string; email: string; name: string };
  company: { id: string; name: string; slug: string } | null;
  accessToken: string;
  refreshToken: string;
  verification: {
    status: string;
    expiresAt: string | null;
    delivery: string | null;
    /** present only where nothing was dispatched */
    verifyUrl: string | null;
  };
}

export default function RegisterPage() {
  const { reload } = useAuth();
  const navigate = useNavigate();
  const action = useAuthAction();
  const policy = usePasswordPolicy();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [created, setCreated] = useState<RegisterResponse | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const body: Record<string, unknown> = {
      name: name.trim(),
      email: email.trim().toLowerCase(),
      password,
    };
    if (companyName.trim()) body["companyName"] = companyName.trim();
    const res = await action.run("register", () =>
      api.post<RegisterResponse>("/api/v1/auth/register", body),
    );
    if (!res) return;
    tokenStore.set(res);
    if (res.company) tokenStore.setCompany(res.company.id);
    setCreated(res);
  }

  async function enter() {
    await reload();
    navigate("/", { replace: true });
  }

  if (created) {
    const undelivered = Boolean(created.verification.verifyUrl);
    return (
      <AuthShell
        title="Account created"
        subtitle={
          created.company
            ? `${created.company.name} is set up with you as its owner.`
            : "You are signed in. You are not yet a member of any company workspace."
        }
        width="md"
      >
        <Alert
          tone={undelivered ? "warning" : "info"}
          title={
            undelivered
              ? "Nothing was emailed — this deployment has no mail transport"
              : "Confirm your address"
          }
        >
          {undelivered ? (
            <>
              <p>
                The verification message was composed and recorded, but not delivered. Reporting it
                as sent would make a link nobody receives look successful, so here is the link
                itself — shown to you, the person who just typed the address, and to nobody else.
              </p>
              <p className="mt-2 break-all font-mono text-2xs">
                <a className="text-accent-text underline" href={created.verification.verifyUrl!}>
                  {created.verification.verifyUrl}
                </a>
              </p>
            </>
          ) : (
            <p>
              A verification link is on its way to{" "}
              <strong>{created.user.email}</strong>
              {created.verification.expiresAt
                ? `. It expires ${new Date(created.verification.expiresAt).toLocaleString()}.`
                : "."}{" "}
              You can sign in and work while it is outstanding — an unverified address may read
              everything your permissions allow and change its own password, but may not invite
              anybody else, because that would send a message in the company&rsquo;s name.
            </p>
          )}
        </Alert>

        <Button className="mt-4" fullWidth onClick={() => void enter()}>
          Continue to ConstructOS
        </Button>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Create your account"
      subtitle="Naming a company sets up a new workspace with you as its owner. Leave it blank if you are joining one by invitation."
      footer={
        <p>
          Already have an account? <AuthLink to="/login">Sign in</AuthLink>
        </p>
      }
    >
      <FailureAlert failure={action.failure} onDismiss={action.clear} />
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Full name">
          <Input
            autoComplete="name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Jane Rivera"
          />
        </Field>
        <Field label="Work email">
          <Input
            type="email"
            autoComplete="username email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
          />
        </Field>
        <Field
          label="Password"
          hint={policy ? undefined : "The policy is enforced by the server."}
        >
          <Input
            type="password"
            autoComplete="new-password"
            required
            minLength={policy?.minLength ?? 8}
            maxLength={policy?.maxLength ?? 256}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
          />
          <PolicyHint policy={policy} />
        </Field>
        <Field label="Company name" optional hint="Creates a new workspace with you as owner.">
          <Input
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            placeholder="Rivera Construction Ltd"
          />
        </Field>
        <Button type="submit" fullWidth loading={action.busy === "register"}>
          Create account
        </Button>
      </form>
    </AuthShell>
  );
}
