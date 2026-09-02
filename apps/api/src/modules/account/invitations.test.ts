import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  companyMemberships,
  emailDispatches,
  userInvitations,
  users,
} from "@constructos/db";
import type { BuiltApp } from "../../app.js";
import { buildTestApp } from "../../test/helpers.js";
import {
  createHttpTransport,
  createStubEmailClient,
  type EmailHttpResponse,
} from "../../lib/email.js";
import { useEmailTransport } from "./mailer.js";
import { mintToken } from "./tokens.js";
import { newId } from "../../lib/ids.js";

/**
 * Invitations, from "an administrator typed an address" to "somebody signed in
 * holding a role".
 *
 * What is being defended here, in order of how badly it would end:
 *   - an invitation that reports success while nothing was sent;
 *   - an administrator taking over a stranger's account by inviting them;
 *   - an accept link that works twice, or after it expired, or after it was
 *     revoked, or after it was replaced by a resend;
 *   - the temporary password the inviter was handed still working afterwards.
 */

const PASSWORD = "scaffold-tower-brick";
const INVITEE_PASSWORD = "gantry-crane-lintel";
let counter = 0;

interface Owner {
  userId: string;
  email: string;
  companyId: string;
  headers: Record<string, string>;
  verifyUrl: string | null;
}

function tokenFromUrl(url: string): string {
  return new URL(url).searchParams.get("token") ?? "";
}

async function signUp(app: FastifyInstance, companyName?: string): Promise<Owner> {
  counter += 1;
  const email = `inv${counter}-${Date.now()}@test.dev`;
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: {
      email,
      password: PASSWORD,
      name: `Invite Owner ${counter}`,
      companyName: companyName ?? `Invite Co ${counter}`,
    },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as {
    user: { id: string };
    company: { id: string };
    accessToken: string;
    verification: { verifyUrl: string | null };
  };
  return {
    userId: body.user.id,
    email,
    companyId: body.company.id,
    headers: {
      authorization: `Bearer ${body.accessToken}`,
      "x-company-id": body.company.id,
    },
    verifyUrl: body.verification.verifyUrl,
  };
}

describe("invitations", () => {
  let built: BuiltApp;
  let app: FastifyInstance;
  let owner: Owner;

  const invite = (headers: Record<string, string>, payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/api/v1/company/users/invite", headers, payload });

  const accept = (payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/api/v1/auth/invitations/accept", payload });

  beforeAll(async () => {
    built = await buildTestApp();
    app = built.app;
    owner = await signUp(app, "Brightwell Construction");
  });

  afterAll(async () => {
    await built.close();
  });

  it("records the invitation, says it was NOT sent, and hands back the link", async () => {
    const email = `newhire-${Date.now()}@test.dev`;
    const res = await invite(owner.headers, { email, name: "New Hire", role: "member" });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      tempPassword?: string;
      existingUser: boolean;
      invitation: { id: string; status: string; expiresAt: string; tokenPrefix: string };
      delivery: { dispatched: boolean; status: string; reasons: string[] };
      acceptUrl: string | null;
    };
    // unchanged for existing callers
    expect(body.existingUser).toBe(false);
    expect(body.tempPassword).toHaveLength(16);
    // and the honesty the route did not have before
    expect(body.delivery.dispatched).toBe(false);
    expect(body.delivery.status).toBe("recorded");
    expect(body.delivery.reasons.join(" ")).toContain("EMAIL_PROVIDER");
    expect(body.acceptUrl).toContain("token=");
    expect(body.invitation.status).toBe("pending");

    const [row] = await app.db
      .select()
      .from(userInvitations)
      .where(eq(userInvitations.email, email));
    expect(row!.tokenHash).toHaveLength(64);
    expect(row!.tokenPrefix).toBe(body.invitation.tokenPrefix);
    expect(tokenFromUrl(body.acceptUrl!).startsWith(row!.tokenPrefix!)).toBe(true);
    expect(row!.sendCount).toBe(1);

    const [dispatch] = await app.db
      .select()
      .from(emailDispatches)
      .where(and(eq(emailDispatches.toEmail, email), eq(emailDispatches.template, "invitation")));
    expect(dispatch!.status).toBe("recorded");
    expect(dispatch!.relatedId).toBe(row!.id);
    expect(dispatch!.bodyPreview).not.toContain(tokenFromUrl(body.acceptUrl!));
  });

  it("lists pending invitations for administrators, without the token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/company/invitations",
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: { status: string; email: string }[] };
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    expect(body.items.every((i) => i.status === "pending")).toBe(true);
    expect(res.body).not.toContain("tokenHash");
  });

  it("previews a link without spending it, then accepts it once", async () => {
    const email = `accepts-${Date.now()}@test.dev`;
    const invited = await invite(owner.headers, { email, name: "Accepts Once", role: "member" });
    const token = tokenFromUrl((invited.json() as { acceptUrl: string }).acceptUrl);
    const tempPassword = (invited.json() as { tempPassword: string }).tempPassword;

    const preview = await app.inject({
      method: "POST",
      url: "/api/v1/auth/invitations/preview",
      payload: { token },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      valid: true,
      invitation: { email, role: "member", companyName: "Brightwell Construction" },
      requires: { newPassword: true, currentPassword: false },
    });

    const weak = await accept({ token, password: "password1234" });
    expect(weak.statusCode).toBe(400);
    expect(weak.json().details.reasons.length).toBeGreaterThan(0);

    const ok = await accept({ token, password: INVITEE_PASSWORD, name: "Accepts Once" });
    expect(ok.statusCode).toBe(200);
    const body = ok.json() as {
      user: { id: string };
      company: { role: string };
      passwordSet: boolean;
      accessToken: string;
      session: { authMethod: string };
    };
    expect(body.passwordSet).toBe(true);
    expect(body.company.role).toBe("member");
    expect(body.session.authMethod).toBe("invitation");

    // the token it was issued for is now spent
    const replay = await accept({ token, password: INVITEE_PASSWORD });
    expect(replay.statusCode).toBe(400);
    expect(replay.json().details.reasons.join(" ")).toContain("already been accepted");

    // the temporary password the administrator was handed no longer works
    const oldWay = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: tempPassword },
    });
    expect(oldWay.statusCode).toBe(401);
    const newWay = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: INVITEE_PASSWORD },
    });
    expect(newWay.statusCode).toBe(200);

    // and the session it minted is a working, listable device
    const sessions = await app.inject({
      method: "GET",
      url: "/api/v1/account/sessions",
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    expect(sessions.statusCode).toBe(200);

    const [row] = await app.db
      .select()
      .from(userInvitations)
      .where(eq(userInvitations.email, email));
    expect(row!.status).toBe("accepted");
    expect(row!.acceptedUserId).toBe(body.user.id);
    expect(row!.acceptedUserId).not.toBe(row!.invitedBy);
  });

  it("expires, sweeps lazily on the list read, and refuses acceptance afterwards", async () => {
    const email = `expires-${Date.now()}@test.dev`;
    const invited = await invite(owner.headers, { email, name: "Too Slow", role: "member" });
    const token = tokenFromUrl((invited.json() as { acceptUrl: string }).acceptUrl);
    await app.db
      .update(userInvitations)
      .set({ expiresAt: new Date(Date.now() - 60_000).toISOString() })
      .where(eq(userInvitations.email, email));

    const refused = await accept({ token, password: INVITEE_PASSWORD });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().details.reasons.join(" ")).toContain("expired");

    const first = await app.inject({
      method: "GET",
      url: "/api/v1/company/invitations",
      headers: owner.headers,
    });
    // the accept attempt already swept it; the read is idempotent either way
    const listed = (first.json() as { items: { email: string; status: string }[] }).items.find(
      (i) => i.email === email,
    );
    expect(listed!.status).toBe("expired");
    const second = await app.inject({
      method: "GET",
      url: "/api/v1/company/invitations",
      headers: owner.headers,
    });
    expect((second.json() as { sweptExpired: number }).sweptExpired).toBe(0);
  });

  it("can be revoked, after which the link is dead", async () => {
    const email = `revoked-${Date.now()}@test.dev`;
    const invited = await invite(owner.headers, { email, name: "Changed Mind", role: "member" });
    const token = tokenFromUrl((invited.json() as { acceptUrl: string }).acceptUrl);
    const invitationId = (invited.json() as { invitation: { id: string } }).invitation.id;

    const revoke = await app.inject({
      method: "POST",
      url: `/api/v1/company/invitations/${invitationId}/revoke`,
      headers: owner.headers,
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json().invitation).toMatchObject({ status: "revoked", revokedBy: owner.userId });

    const refused = await accept({ token, password: INVITEE_PASSWORD });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().details.reasons.join(" ")).toContain("revoked");
  });

  it("resending replaces the link rather than adding a second one", async () => {
    const email = `resend-${Date.now()}@test.dev`;
    const invited = await invite(owner.headers, { email, name: "Lost It", role: "member" });
    const first = tokenFromUrl((invited.json() as { acceptUrl: string }).acceptUrl);
    const invitationId = (invited.json() as { invitation: { id: string } }).invitation.id;

    const resent = await app.inject({
      method: "POST",
      url: `/api/v1/company/invitations/${invitationId}/resend`,
      headers: owner.headers,
    });
    expect(resent.statusCode).toBe(200);
    const body = resent.json() as {
      acceptUrl: string;
      invitation: { sendCount: number };
      delivery: { dispatched: boolean };
    };
    expect(body.invitation.sendCount).toBe(2);
    expect(body.delivery.dispatched).toBe(false);
    const second = tokenFromUrl(body.acceptUrl);
    expect(second).not.toBe(first);

    expect((await accept({ token: first, password: INVITEE_PASSWORD })).statusCode).toBe(400);
    expect((await accept({ token: second, password: INVITEE_PASSWORD })).statusCode).toBe(200);
  });

  it("refuses to resend an invitation that is no longer pending", async () => {
    const email = `noresend-${Date.now()}@test.dev`;
    const invited = await invite(owner.headers, { email, name: "Done", role: "member" });
    const invitationId = (invited.json() as { invitation: { id: string } }).invitation.id;
    await app.inject({
      method: "POST",
      url: `/api/v1/company/invitations/${invitationId}/revoke`,
      headers: owner.headers,
    });
    const resent = await app.inject({
      method: "POST",
      url: `/api/v1/company/invitations/${invitationId}/resend`,
      headers: owner.headers,
    });
    expect(resent.statusCode).toBe(409);
  });

  /* ---------------------------------------------------------------- */

  it("will not let an administrator take over an address that already has an account", async () => {
    const stranger = await signUp(app, "Stranger Holdings");
    const res = await invite(owner.headers, {
      email: stranger.email,
      name: "Ignored",
      role: "guest",
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      existingUser: boolean;
      tempPassword?: string;
      acceptUrl: string | null;
      invitation: { id: string };
    };
    expect(body.existingUser).toBe(true);
    expect(body.tempPassword).toBeUndefined();
    // THE POINT: no link comes back for an account this invitation did not
    // create, because that link would set a password on somebody else's
    // account.
    expect(body.acceptUrl).toBeNull();

    // even holding the token (read here the way only the mailbox owner could),
    // the invitation cannot set a password
    const [row] = await app.db
      .select()
      .from(userInvitations)
      .where(eq(userInvitations.id, body.invitation.id));
    const outbox = (await import("./mailer.js")).emailTransportFor(app) as unknown as {
      recorded: () => { to: { email: string }; text: string }[];
    };
    const message = [...outbox.recorded()].reverse().find((m) => m.to.email === stranger.email);
    const token = message!.text.match(/invitations\/accept\?token=([^\s]+)/)![1]!;
    expect(row!.tokenPrefix && token.startsWith(row!.tokenPrefix)).toBe(true);

    const takeover = await accept({ token, password: "brand-new-password-x" });
    expect(takeover.statusCode).toBe(401);
    expect(takeover.json().message).toContain("current password");
    // the stranger's password is untouched
    const stillTheirs = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: stranger.email, password: PASSWORD },
    });
    expect(stillTheirs.statusCode).toBe(200);

    // signing in to accept works, and binds the role
    const joined = await accept({ token, password: PASSWORD });
    expect(joined.statusCode).toBe(200);
    expect(joined.json().passwordSet).toBe(false);
    const [membership] = await app.db
      .select()
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, owner.companyId),
          eq(companyMemberships.userId, stranger.userId),
        ),
      );
    expect(membership!.role).toBe("guest");
  });

  it("refuses an invitation accepted by the person who sent it", async () => {
    // Crafted directly: the route would refuse to invite an existing member,
    // so this is the only way to reach the segregation check that guards
    // against an inviter who also controls the invited mailbox.
    const token = mintToken();
    await app.db.insert(userInvitations).values({
      id: newId("inv"),
      companyId: owner.companyId,
      email: owner.email,
      name: "Myself",
      role: "owner",
      tokenHash: token.hash,
      tokenPrefix: token.prefix,
      status: "pending",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      invitedBy: owner.userId,
    });
    const res = await accept({ token: token.raw, password: INVITEE_PASSWORD });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toContain("cannot accept it");
  });

  /* ---------------------------------------------------------------- */

  describe("with a transport that really dispatches", () => {
    const outbound: EmailHttpResponse[] = [];

    afterAll(() => {
      useEmailTransport(app, null);
    });

    it("reports a real send, records the provider's id, and stops handing out the link", async () => {
      const client = createStubEmailClient(() => {
        const response = outbound.shift() ?? {
          status: 200,
          body: JSON.stringify({ id: "resend-msg-1" }),
        };
        return response;
      });
      useEmailTransport(
        app,
        createHttpTransport({
          provider: "resend",
          apiKey: "test-key",
          from: { email: "noreply@constructos.test", name: "ConstructOS" },
          client,
        }),
      );

      // The inviter must now prove their own address: this deployment CAN send
      // mail, so the verification gate is live.
      const blocked = await invite(owner.headers, {
        email: `gated-${Date.now()}@test.dev`,
        name: "Gated",
        role: "member",
      });
      expect(blocked.statusCode).toBe(403);
      expect(blocked.json().message).toContain("Confirm your email address");

      const verified = await app.inject({
        method: "POST",
        url: "/api/v1/auth/verify-email",
        payload: { token: tokenFromUrl(owner.verifyUrl!) },
      });
      expect(verified.statusCode).toBe(200);

      const email = `dispatched-${Date.now()}@test.dev`;
      const res = await invite(owner.headers, { email, name: "Really Sent", role: "member" });
      expect(res.statusCode).toBe(201);
      const body = res.json() as {
        delivery: { dispatched: boolean; status: string; reasons: string[] };
        acceptUrl: string | null;
      };
      expect(body.delivery).toMatchObject({ dispatched: true, status: "sent", reasons: [] });
      // nothing is handed back once the message is genuinely on its way
      expect(body.acceptUrl).toBeNull();

      const [dispatch] = await app.db
        .select()
        .from(emailDispatches)
        .where(eq(emailDispatches.toEmail, email));
      expect(dispatch!.status).toBe("sent");
      expect(dispatch!.transport).toBe("http");
      expect(dispatch!.provider).toBe("resend");
      expect(dispatch!.providerMessageId).toBe("resend-msg-1");
      expect(dispatch!.dispatchedAt).toBeTruthy();
      expect(dispatch!.bodyPreview).toContain("[redacted]");
    });

    it("records a provider rejection as failed without failing the invitation", async () => {
      outbound.push({ status: 422, body: '{"message":"domain not verified"}' });
      const email = `rejected-${Date.now()}@test.dev`;
      const res = await invite(owner.headers, { email, name: "Bounced", role: "member" });
      expect(res.statusCode).toBe(201);
      const body = res.json() as {
        delivery: { dispatched: boolean; status: string; reasons: string[] };
        acceptUrl: string | null;
      };
      expect(body.delivery.dispatched).toBe(false);
      expect(body.delivery.status).toBe("failed");
      expect(body.delivery.reasons.join(" ")).toContain("422");
      // the account was created, so the link is the way to rescue the invite
      expect(body.acceptUrl).toContain("token=");

      const [dispatch] = await app.db
        .select()
        .from(emailDispatches)
        .where(eq(emailDispatches.toEmail, email));
      expect(dispatch!.status).toBe("failed");
      expect(dispatch!.error).toContain("domain not verified");
      expect(dispatch!.dispatchedAt).toBeNull();
    });

    it("still lets an unverified administrator invite once verification is impossible", async () => {
      // Back to the no-op transport: nobody could verify an address, so the
      // gate stands down rather than locking the company out of inviting.
      useEmailTransport(app, null);
      const unverified = await signUp(app, "Unverified Co");
      const res = await invite(unverified.headers, {
        email: `ungated-${Date.now()}@test.dev`,
        name: "Ungated",
        role: "member",
      });
      expect(res.statusCode).toBe(201);
    });
  });

  it("keeps the invited user out of companies they were not invited to", async () => {
    const other = await signUp(app, "Unrelated Co");
    const rows = await app.db
      .select()
      .from(companyMemberships)
      .where(eq(companyMemberships.companyId, other.companyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(other.userId);
  });

  it("records the whole invitation life in the security trail", async () => {
    const email = `trail-${Date.now()}@test.dev`;
    const invited = await invite(owner.headers, { email, name: "Trail", role: "member" });
    const token = tokenFromUrl((invited.json() as { acceptUrl: string }).acceptUrl);
    await accept({ token, password: INVITEE_PASSWORD });

    const [invitee] = await app.db.select().from(users).where(eq(users.email, email));
    expect(invitee).toBeTruthy();

    const trail = await app.inject({
      method: "GET",
      url: "/api/v1/account/security-events",
      headers: { authorization: `Bearer ${(await signInAs(app, email, INVITEE_PASSWORD))}` },
    });
    expect(trail.statusCode).toBe(200);
    const kinds = (trail.json() as { items: { kind: string }[] }).items.map((i) => i.kind);
    expect(kinds).toContain("invitation_accepted");
    expect(kinds).toContain("login_success");
  });
});

async function signInAs(
  app: FastifyInstance,
  email: string,
  password: string,
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password },
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { accessToken: string }).accessToken;
}
