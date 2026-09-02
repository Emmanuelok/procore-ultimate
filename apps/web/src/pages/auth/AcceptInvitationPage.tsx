/**
 * ACCEPT AN INVITATION.
 *
 * The flow has TWO shapes and the difference is the security of the whole
 * thing, so the page asks the server which one applies rather than guessing:
 *
 *  - The invitation CREATED the account (a new hire). The invitee sets their
 *    own password here; every session opened with the temporary password the
 *    administrator was handed is destroyed, and they are signed in.
 *  - The address ALREADY had an account. The invitation may NOT set a password;
 *    the current one has to be presented. Otherwise an administrator holding an
 *    undispatched accept link could take over a stranger's account by inviting
 *    them.
 *
 * `POST /auth/invitations/preview` answers that with `requires`, and shows who
 * invited you and to what — without spending the token.
 */
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Alert, Badge, Button, Field, Input } from "../../ui";
import { api, tokenStore } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import {
  AuthLink,
  AuthShell,
  FailureAlert,
  PolicyHint,
  Reasons,
  useAuthAction,
  usePasswordPolicy,
} from "./authShared";

interface Preview {
  valid: boolean;
  reasons: string[];
  invitation: {
    email: string;
    name: string | null;
    role: string;
    companyName: string | null;
    inviterName: string | null;
    message: string | null;
    expiresAt: string | null;
    status: string;
  } | null;
  requires?: { currentPassword: boolean; newPassword: boolean };
}

interface Accepted {
  user: { id: string; email: string; name: string };
  company: { id: string; name: string; slug: string; role: string } | null;
  invitation: { id: string; status: string; role: string };
  projects: string[];
  passwordSet: boolean;
  accessToken: string;
  refreshToken: string;
}

export default function AcceptInvitationPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { reload } = useAuth();
  const action = useAuthAction();
  const policy = usePasswordPolicy();

  const token = searchParams.get("token") ?? "";
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(Boolean(token));
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [accepted, setAccepted] = useState<Accepted | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    api
      .post<Preview>("/api/v1/auth/invitations/preview", { token })
      .then((res) => {
        if (cancelled) return;
        setPreview(res);
        setName(res.invitation?.name ?? "");
      })
      .catch(() => {
        if (!cancelled) setPreview({ valid: false, reasons: [], invitation: null });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const body: Record<string, unknown> = { token };
    if (password) body["password"] = password;
    if (name.trim()) body["name"] = name.trim();
    const res = await action.run("accept", () =>
      api.post<Accepted>("/api/v1/auth/invitations/accept", body),
    );
    if (!res) return;
    tokenStore.set(res);
    if (res.company) tokenStore.setCompany(res.company.id);
    setAccepted(res);
  }

  async function enter() {
    await reload();
    navigate("/", { replace: true });
  }

  if (!token) {
    return (
      <AuthShell
        title="This invitation link is incomplete"
        subtitle="An invitation carries a single-use token in its address. Open the link from the message you were sent."
        footer={<AuthLink to="/login">Back to sign in</AuthLink>}
      >
        <Alert tone="warning" size="sm">
          Nothing can be shown without the token — it is the only thing that proves the link is
          yours.
        </Alert>
      </AuthShell>
    );
  }

  if (accepted) {
    return (
      <AuthShell
        title="You're in"
        subtitle={
          accepted.company
            ? `${accepted.company.name} — ${accepted.company.role}`
            : "Invitation accepted."
        }
      >
        <Alert tone="success" title="Invitation accepted">
          <p>
            You are signed in as {accepted.user.email}.
            {accepted.passwordSet
              ? " Your password is set, and every session opened with the temporary one has been destroyed."
              : " Your existing password is unchanged."}
          </p>
          {accepted.projects.length > 0 ? (
            <p className="mt-1 text-meta">
              You have been added to {accepted.projects.length} project
              {accepted.projects.length === 1 ? "" : "s"}.
            </p>
          ) : null}
        </Alert>
        <Button className="mt-4" fullWidth onClick={() => void enter()}>
          Continue to ConstructOS
        </Button>
      </AuthShell>
    );
  }

  if (loading) {
    return (
      <AuthShell title="Checking the invitation" subtitle="Reading the link without spending it.">
        <div className="space-y-2">
          <div className="h-4 w-2/3 animate-pulse rounded bg-surface-sunken" />
          <div className="h-4 w-1/2 animate-pulse rounded bg-surface-sunken" />
          <div className="h-9 w-full animate-pulse rounded bg-surface-sunken" />
        </div>
      </AuthShell>
    );
  }

  if (!preview?.valid) {
    return (
      <AuthShell
        title="This invitation cannot be accepted"
        subtitle={
          preview?.invitation?.companyName
            ? `Invited to ${preview.invitation.companyName}`
            : undefined
        }
        footer={<AuthLink to="/login">Back to sign in</AuthLink>}
      >
        <Alert tone="danger" title="Refused">
          <p>
            An invitation link is single-use and expires. It can also be revoked by whoever sent it.
          </p>
          <Reasons
            reasons={
              preview?.reasons.length ? preview.reasons : ["This link is not valid any more."]
            }
            className="mt-1.5"
          />
        </Alert>
        <p className="mt-4 text-meta text-content-muted">
          Ask whoever invited you to send a fresh invitation.
        </p>
      </AuthShell>
    );
  }

  const invitation = preview.invitation!;
  const needsCurrent = preview.requires?.currentPassword === true;
  const needsNew = preview.requires?.newPassword === true;

  return (
    <AuthShell
      title={
        invitation.companyName ? `Join ${invitation.companyName}` : "Accept your invitation"
      }
      subtitle={
        <>
          {invitation.inviterName ? `${invitation.inviterName} invited ` : "You have been invited "}
          <span className="font-medium text-content">{invitation.email}</span> as{" "}
          <Badge tone="info" size="xs">
            {invitation.role}
          </Badge>
        </>
      }
      footer={<AuthLink to="/login">Sign in instead</AuthLink>}
    >
      <FailureAlert failure={action.failure} onDismiss={action.clear} />

      {invitation.message ? (
        <Alert tone="neutral" variant="subtle" size="sm" className="mb-4">
          <p className="whitespace-pre-wrap italic">&ldquo;{invitation.message}&rdquo;</p>
        </Alert>
      ) : null}

      {needsCurrent ? (
        <Alert tone="info" size="sm" className="mb-4" title="This address already has an account">
          Accepting will add it to {invitation.companyName ?? "the company"}. It will not set a new
          password: an invitation that could change the password of an address that already exists
          would be a way to take over somebody else&rsquo;s account. Sign in first if you are not
          already.
        </Alert>
      ) : null}

      <form onSubmit={onSubmit} className="space-y-4">
        {needsNew ? (
          <>
            <Field label="Your name">
              <Input
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Jane Rivera"
              />
            </Field>
            <Field label="Choose a password">
              <Input
                type="password"
                autoComplete="new-password"
                required
                minLength={policy?.minLength ?? 8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <PolicyHint policy={policy} />
            </Field>
          </>
        ) : null}

        <Button
          type="submit"
          fullWidth
          loading={action.busy === "accept"}
          disabled={needsNew && password.length === 0}
        >
          Accept the invitation
        </Button>
      </form>

      {invitation.expiresAt ? (
        <p className="mt-4 text-2xs text-content-subtle">
          This link expires {new Date(invitation.expiresAt).toLocaleString()}.
        </p>
      ) : null}
    </AuthShell>
  );
}
