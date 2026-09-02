import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import {
  authSecurityEvents,
  authSessions,
  emailDispatches,
  emailVerifications,
  passwordResets,
  users,
} from "@constructos/db";
import type { BuiltApp } from "../../app.js";
import { buildTestApp } from "../../test/helpers.js";
import { hashToken } from "./tokens.js";

/**
 * Account lifecycle, end to end.
 *
 * The tests worth reading here are the ones that describe an attacker: an
 * address probed through the reset form, a link clicked twice, a token that
 * outlived its expiry by a minute, a stolen access token used one second after
 * the account holder pressed "sign out everywhere", and a password hash left
 * at the work factor of 2015.
 */

const PASSWORD = "scaffold-tower-brick";
const NEW_PASSWORD = "gantry-crane-lintel";
let counter = 0;

interface Actor {
  userId: string;
  email: string;
  companyId: string;
  accessToken: string;
  refreshToken: string;
  headers: Record<string, string>;
  verifyUrl: string | null;
}

function tokenFromUrl(url: string): string {
  return new URL(url).searchParams.get("token") ?? "";
}

async function signUp(app: FastifyInstance, password = PASSWORD): Promise<Actor> {
  counter += 1;
  const email = `acct${counter}-${Date.now()}@test.dev`;
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email, password, name: `Account User ${counter}`, companyName: `Acct Co ${counter}` },
    headers: { "user-agent": "Mozilla/5.0 (Macintosh) Chrome/140.0" },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as {
    user: { id: string };
    company: { id: string };
    accessToken: string;
    refreshToken: string;
    verification: { verifyUrl: string | null };
  };
  return {
    userId: body.user.id,
    email,
    companyId: body.company.id,
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    headers: {
      authorization: `Bearer ${body.accessToken}`,
      "x-company-id": body.company.id,
    },
    verifyUrl: body.verification.verifyUrl,
  };
}

async function signIn(
  app: FastifyInstance,
  email: string,
  password: string,
  userAgent = "Mozilla/5.0 (Windows NT 10.0) Firefox/141.0",
) {
  return app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password },
    headers: { "user-agent": userAgent },
  });
}

describe("account lifecycle", () => {
  let built: BuiltApp;
  let app: FastifyInstance;

  beforeAll(async () => {
    built = await buildTestApp();
    app = built.app;
  });

  afterAll(async () => {
    await built.close();
  });

  /* ================================================================ */
  describe("email verification", () => {
    it("registration composes a verification message and reports it as NOT dispatched", async () => {
      const actor = await signUp(app);
      expect(actor.verifyUrl).toBeTruthy();

      const rows = await app.db
        .select()
        .from(emailDispatches)
        .where(eq(emailDispatches.toEmail, actor.email));
      expect(rows).toHaveLength(1);
      const dispatch = rows[0]!;
      expect(dispatch.template).toBe("verify_email");
      expect(dispatch.status).toBe("recorded");
      expect(dispatch.dispatchedAt).toBeNull();
      expect(dispatch.reasons.join(" ")).toContain("EMAIL_PROVIDER");
    });

    it("never stores the live link: the recorded body is redacted", async () => {
      const actor = await signUp(app);
      const raw = tokenFromUrl(actor.verifyUrl!);
      const [dispatch] = await app.db
        .select()
        .from(emailDispatches)
        .where(eq(emailDispatches.toEmail, actor.email));
      expect(dispatch!.bodyPreview).not.toContain(raw);
      expect(dispatch!.bodyPreview).toContain("[redacted]");
      // and the table stores the digest, never the token
      const [row] = await app.db
        .select()
        .from(emailVerifications)
        .where(eq(emailVerifications.userId, actor.userId));
      expect(row!.tokenHash).toBe(hashToken(raw));
      expect(row!.tokenHash).not.toContain(raw);
    });

    it("reports an unverified address, then a verified one", async () => {
      const actor = await signUp(app);
      const before = await app.inject({
        method: "GET",
        url: "/api/v1/account/verification",
        headers: actor.headers,
      });
      expect(before.statusCode).toBe(200);
      expect(before.json()).toMatchObject({ verified: false, email: actor.email });
      expect(before.json().pending).not.toBeNull();
      // the gate is inert while this deployment cannot send mail, and says so
      expect(before.json().policy.enforced).toBe(false);

      const verify = await app.inject({
        method: "POST",
        url: "/api/v1/auth/verify-email",
        payload: { token: tokenFromUrl(actor.verifyUrl!) },
      });
      expect(verify.statusCode).toBe(200);
      expect(verify.json()).toMatchObject({ verified: true, email: actor.email });

      const after = await app.inject({
        method: "GET",
        url: "/api/v1/account/verification",
        headers: actor.headers,
      });
      expect(after.json().verified).toBe(true);
      expect(after.json().verifiedAt).toBeTruthy();
    });

    it("a verification token is single use", async () => {
      const actor = await signUp(app);
      const token = tokenFromUrl(actor.verifyUrl!);
      const first = await app.inject({
        method: "POST",
        url: "/api/v1/auth/verify-email",
        payload: { token },
      });
      expect(first.statusCode).toBe(200);
      const second = await app.inject({
        method: "POST",
        url: "/api/v1/auth/verify-email",
        payload: { token },
      });
      expect(second.statusCode).toBe(400);
      expect(second.json().message).toContain("already been used");
    });

    it("refuses an unknown token and an expired one", async () => {
      const unknown = await app.inject({
        method: "POST",
        url: "/api/v1/auth/verify-email",
        payload: { token: "a".repeat(43) },
      });
      expect(unknown.statusCode).toBe(400);

      const actor = await signUp(app);
      const token = tokenFromUrl(actor.verifyUrl!);
      await app.db
        .update(emailVerifications)
        .set({ expiresAt: new Date(Date.now() - 60_000).toISOString() })
        .where(eq(emailVerifications.tokenHash, hashToken(token)));
      const expired = await app.inject({
        method: "POST",
        url: "/api/v1/auth/verify-email",
        payload: { token },
      });
      expect(expired.statusCode).toBe(400);
      expect(expired.json().message).toContain("expired");
    });

    it("rate-limits resends per account (registration counts as the first)", async () => {
      const actor = await signUp(app);
      const resend = async () =>
        app.inject({
          method: "POST",
          url: "/api/v1/account/verification/resend",
          headers: actor.headers,
        });
      expect((await resend()).statusCode).toBe(202); // 2nd of 3
      expect((await resend()).statusCode).toBe(202); // 3rd of 3
      const fourth = await resend();
      expect(fourth.statusCode).toBe(429);
      expect(fourth.json().details.retryAfterSeconds).toBeGreaterThan(0);
    });
  });

  /* ================================================================ */
  describe("password policy at the front door", () => {
    it("refuses a short password, a common one, and one built from the address", async () => {
      const attempt = (email: string, password: string) =>
        app.inject({
          method: "POST",
          url: "/api/v1/auth/register",
          payload: { email, password, name: "Policy Probe" },
        });

      const short = await attempt(`short-${Date.now()}@test.dev`, "sh0rt-pass");
      expect(short.statusCode).toBe(400);
      expect(short.json().details.reasons.join(" ")).toContain("at least 12");

      const common = await attempt(`common-${Date.now()}@test.dev`, "password1234");
      expect(common.statusCode).toBe(400);
      expect(common.json().details.reasons.join(" ")).toContain("commonly used");

      const personal = await attempt("marcus.brightwell@test.dev", "marcus.brightwell-2026");
      expect(personal.statusCode).toBe(400);
      expect(personal.json().details.reasons.join(" ")).toContain("email address");
    });
  });

  /* ================================================================ */
  describe("transparent rehash on login", () => {
    it("authenticates an old-cost hash and upgrades it in place", async () => {
      const actor = await signUp(app);
      // A hash written years ago at a lower work factor.
      const legacy = await bcrypt.hash(PASSWORD, 6);
      await app.db
        .update(users)
        .set({ passwordHash: legacy })
        .where(eq(users.id, actor.userId));
      expect(bcrypt.getRounds(legacy)).toBe(6);

      const login = await signIn(app, actor.email, PASSWORD);
      expect(login.statusCode).toBe(200);

      const [row] = await app.db.select().from(users).where(eq(users.id, actor.userId));
      expect(bcrypt.getRounds(row!.passwordHash)).toBeGreaterThan(6);
      // and the upgraded hash still verifies the same password
      expect(await bcrypt.compare(PASSWORD, row!.passwordHash)).toBe(true);
      const again = await signIn(app, actor.email, PASSWORD);
      expect(again.statusCode).toBe(200);
    });
  });

  /* ================================================================ */
  describe("password change", () => {
    it("requires the current password and enforces the policy on the new one", async () => {
      const actor = await signUp(app);
      const wrong = await app.inject({
        method: "POST",
        url: "/api/v1/account/password",
        headers: actor.headers,
        payload: { currentPassword: "not-the-password", newPassword: NEW_PASSWORD },
      });
      expect(wrong.statusCode).toBe(401);

      const weak = await app.inject({
        method: "POST",
        url: "/api/v1/account/password",
        headers: actor.headers,
        payload: { currentPassword: PASSWORD, newPassword: "password1234" },
      });
      expect(weak.statusCode).toBe(400);
      expect(weak.json().details.reasons.length).toBeGreaterThan(0);

      const same = await app.inject({
        method: "POST",
        url: "/api/v1/account/password",
        headers: actor.headers,
        payload: { currentPassword: PASSWORD, newPassword: PASSWORD },
      });
      expect(same.statusCode).toBe(400);

      const ok = await app.inject({
        method: "POST",
        url: "/api/v1/account/password",
        headers: actor.headers,
        payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      });
      expect(ok.statusCode).toBe(200);
      expect((await signIn(app, actor.email, PASSWORD)).statusCode).toBe(401);
      expect((await signIn(app, actor.email, NEW_PASSWORD)).statusCode).toBe(200);
    });

    it("signs other devices out but keeps the device that changed it", async () => {
      const actor = await signUp(app);
      const other = await signIn(app, actor.email, PASSWORD);
      const otherToken = (other.json() as { accessToken: string }).accessToken;

      const changed = await app.inject({
        method: "POST",
        url: "/api/v1/account/password",
        headers: actor.headers,
        payload: {
          currentPassword: PASSWORD,
          newPassword: NEW_PASSWORD,
          signOutOtherDevices: true,
        },
      });
      expect(changed.statusCode).toBe(200);
      expect(changed.json().sessionsRevoked).toBeGreaterThanOrEqual(1);

      // the other device is refused on its very next request
      const refused = await app.inject({
        method: "GET",
        url: "/api/v1/account/sessions",
        headers: { authorization: `Bearer ${otherToken}` },
      });
      expect(refused.statusCode).toBe(401);
      // ...and the device that made the change is still signed in
      const still = await app.inject({
        method: "GET",
        url: "/api/v1/account/sessions",
        headers: actor.headers,
      });
      expect(still.statusCode).toBe(200);
    });

    it("can leave other devices alone when asked to", async () => {
      const actor = await signUp(app);
      const other = await signIn(app, actor.email, PASSWORD);
      const otherToken = (other.json() as { accessToken: string }).accessToken;
      const changed = await app.inject({
        method: "POST",
        url: "/api/v1/account/password",
        headers: actor.headers,
        payload: {
          currentPassword: PASSWORD,
          newPassword: NEW_PASSWORD,
          signOutOtherDevices: false,
        },
      });
      expect(changed.statusCode).toBe(200);
      expect(changed.json().sessionsRevoked).toBe(0);
      const still = await app.inject({
        method: "GET",
        url: "/api/v1/account/sessions",
        headers: { authorization: `Bearer ${otherToken}` },
      });
      expect(still.statusCode).toBe(200);
    });
  });

  /* ================================================================ */
  describe("sessions and devices", () => {
    it("lists devices with a label, an address and the current-session marker", async () => {
      const actor = await signUp(app);
      await signIn(app, actor.email, PASSWORD, "Mozilla/5.0 (Windows NT 10.0) Firefox/141.0");
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/account/sessions",
        headers: actor.headers,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        items: { id: string; current: boolean; deviceLabel: string; lastSeenAt: string }[];
        currentSessionKnown: boolean;
      };
      expect(body.items.length).toBe(2);
      expect(body.currentSessionKnown).toBe(true);
      expect(body.items.filter((s) => s.current)).toHaveLength(1);
      expect(body.items.map((s) => s.deviceLabel)).toContain("Chrome on macOS");
      expect(body.items.map((s) => s.deviceLabel)).toContain("Firefox on Windows");
    });

    it("refuses a revoked session on its NEXT request, not at the next refresh", async () => {
      const actor = await signUp(app);
      const other = await signIn(app, actor.email, PASSWORD);
      const otherBody = other.json() as {
        accessToken: string;
        refreshToken: string;
        session: { id: string };
      };
      // the stolen token works right up to the moment it is revoked
      const before = await app.inject({
        method: "GET",
        url: "/api/v1/account/sessions",
        headers: { authorization: `Bearer ${otherBody.accessToken}` },
      });
      expect(before.statusCode).toBe(200);

      const revoke = await app.inject({
        method: "DELETE",
        url: `/api/v1/account/sessions/${otherBody.session.id}`,
        headers: actor.headers,
      });
      expect(revoke.statusCode).toBe(200);
      expect(revoke.json()).toMatchObject({ revoked: 1, wasCurrentSession: false });

      const after = await app.inject({
        method: "GET",
        url: "/api/v1/account/sessions",
        headers: { authorization: `Bearer ${otherBody.accessToken}` },
      });
      expect(after.statusCode).toBe(401);
      // and its refresh token cannot mint a replacement
      const refreshed = await app.inject({
        method: "POST",
        url: "/api/v1/auth/refresh",
        payload: { refreshToken: otherBody.refreshToken },
      });
      expect(refreshed.statusCode).toBe(401);
    });

    it("cannot revoke somebody else's session, and is not told it exists", async () => {
      const mine = await signUp(app);
      const theirs = await signUp(app);
      const sessions = await app.inject({
        method: "GET",
        url: "/api/v1/account/sessions",
        headers: theirs.headers,
      });
      const theirSessionId = (sessions.json() as { items: { id: string }[] }).items[0]!.id;
      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/account/sessions/${theirSessionId}`,
        headers: mine.headers,
      });
      expect(res.statusCode).toBe(404);
    });

    it("revokes every other device and keeps the caller signed in", async () => {
      const actor = await signUp(app);
      const a = await signIn(app, actor.email, PASSWORD);
      const b = await signIn(app, actor.email, PASSWORD, "Mozilla/5.0 (Linux; Android 15)");
      const tokenA = (a.json() as { accessToken: string }).accessToken;
      const tokenB = (b.json() as { accessToken: string }).accessToken;

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/account/sessions/revoke-others",
        headers: actor.headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ revoked: 2, keptCurrentSession: true });

      for (const token of [tokenA, tokenB]) {
        const refused = await app.inject({
          method: "GET",
          url: "/api/v1/account/sessions",
          headers: { authorization: `Bearer ${token}` },
        });
        expect(refused.statusCode).toBe(401);
      }
      const kept = await app.inject({
        method: "GET",
        url: "/api/v1/account/sessions",
        headers: actor.headers,
      });
      expect(kept.statusCode).toBe(200);
      expect((kept.json() as { items: unknown[] }).items).toHaveLength(1);
    });

    it("survives refresh rotation as the same device", async () => {
      const actor = await signUp(app);
      const before = await app.inject({
        method: "GET",
        url: "/api/v1/account/sessions",
        headers: actor.headers,
      });
      const sessionId = (before.json() as { items: { id: string }[] }).items[0]!.id;

      const rotated = await app.inject({
        method: "POST",
        url: "/api/v1/auth/refresh",
        payload: { refreshToken: actor.refreshToken },
      });
      expect(rotated.statusCode).toBe(200);
      const body = rotated.json() as { accessToken: string; session: { id: string } };
      expect(body.session.id).toBe(sessionId);

      const after = await app.inject({
        method: "GET",
        url: "/api/v1/account/sessions",
        headers: { authorization: `Bearer ${body.accessToken}` },
      });
      expect((after.json() as { items: unknown[] }).items).toHaveLength(1);
    });

    it("sweeps a session past its absolute lifetime, lazily and idempotently", async () => {
      const actor = await signUp(app);
      const other = await signIn(app, actor.email, PASSWORD);
      const otherId = (other.json() as { session: { id: string } }).session.id;
      await app.db
        .update(authSessions)
        .set({ expiresAt: new Date(Date.now() - 86_400_000).toISOString() })
        .where(eq(authSessions.id, otherId));

      const first = await app.inject({
        method: "GET",
        url: "/api/v1/account/sessions",
        headers: actor.headers,
      });
      expect(first.json().sweptExpired).toBe(1);
      expect((first.json() as { items: unknown[] }).items).toHaveLength(1);
      const second = await app.inject({
        method: "GET",
        url: "/api/v1/account/sessions",
        headers: actor.headers,
      });
      expect(second.json().sweptExpired).toBe(0);
    });

    it("tells the account holder about a sign-in from a device it has not seen", async () => {
      const actor = await signUp(app); // registered from "Chrome on macOS"
      const before = await app.db
        .select()
        .from(emailDispatches)
        .where(
          and(
            eq(emailDispatches.toEmail, actor.email),
            eq(emailDispatches.template, "new_device_sign_in"),
          ),
        );
      expect(before).toHaveLength(0);

      await signIn(app, actor.email, PASSWORD, "Mozilla/5.0 (Windows NT 10.0) Firefox/141.0");
      const after = await app.db
        .select()
        .from(emailDispatches)
        .where(
          and(
            eq(emailDispatches.toEmail, actor.email),
            eq(emailDispatches.template, "new_device_sign_in"),
          ),
        );
      expect(after).toHaveLength(1);
      expect(after[0]!.status).toBe("recorded");
      expect(after[0]!.subject).toContain("New sign-in");
      // the message never guesses a location it does not know
      expect(after[0]!.bodyPreview).not.toContain("undefined");

      const events = await app.db
        .select()
        .from(authSecurityEvents)
        .where(
          and(
            eq(authSecurityEvents.userId, actor.userId),
            eq(authSecurityEvents.kind, "new_device_sign_in"),
          ),
        );
      expect(events).toHaveLength(1);
    });

    it("does not repeat the notification for a device it already knows", async () => {
      const actor = await signUp(app);
      const ua = "Mozilla/5.0 (Windows NT 10.0) Firefox/141.0";
      await signIn(app, actor.email, PASSWORD, ua);
      await signIn(app, actor.email, PASSWORD, ua);
      const rows = await app.db
        .select()
        .from(emailDispatches)
        .where(
          and(
            eq(emailDispatches.toEmail, actor.email),
            eq(emailDispatches.template, "new_device_sign_in"),
          ),
        );
      expect(rows).toHaveLength(1);
    });

    it("signing out revokes the device, not just the token", async () => {
      const actor = await signUp(app);
      const out = await app.inject({
        method: "POST",
        url: "/api/v1/auth/logout",
        payload: { refreshToken: actor.refreshToken },
      });
      expect(out.statusCode).toBe(200);
      const after = await app.inject({
        method: "GET",
        url: "/api/v1/account/sessions",
        headers: actor.headers,
      });
      expect(after.statusCode).toBe(401);
    });
  });

  /* ================================================================ */
  describe("password reset", () => {
    it("answers identically for an address that exists and one that does not", async () => {
      const actor = await signUp(app);
      const known = await app.inject({
        method: "POST",
        url: "/api/v1/auth/password-reset",
        payload: { email: actor.email },
      });
      const unknown = await app.inject({
        method: "POST",
        url: "/api/v1/auth/password-reset",
        payload: { email: `nobody-${Date.now()}@test.dev` },
      });
      expect(known.statusCode).toBe(202);
      expect(unknown.statusCode).toBe(202);
      // byte for byte, including the transport block
      expect(known.body).toBe(unknown.body);
      expect(known.json().transport).toMatchObject({ configured: false, kind: "noop" });
    });

    it("never returns the reset link, and never stores it", async () => {
      const actor = await signUp(app);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/password-reset",
        payload: { email: actor.email },
      });
      expect(res.body).not.toContain("token=");
      expect(res.body).not.toContain("/reset-password");

      const [row] = await app.db
        .select()
        .from(passwordResets)
        .where(eq(passwordResets.email, actor.email));
      const [dispatch] = await app.db
        .select()
        .from(emailDispatches)
        .where(
          and(
            eq(emailDispatches.toEmail, actor.email),
            eq(emailDispatches.template, "password_reset"),
          ),
        );
      expect(row!.tokenHash).toHaveLength(64);
      expect(dispatch!.bodyPreview).toContain("[redacted]");
      expect(dispatch!.status).toBe("recorded");
    });

    it("writes no reset row for an address with no account", async () => {
      const email = `ghost-${Date.now()}@test.dev`;
      await app.inject({
        method: "POST",
        url: "/api/v1/auth/password-reset",
        payload: { email },
      });
      const rows = await app.db
        .select()
        .from(passwordResets)
        .where(eq(passwordResets.email, email));
      expect(rows).toHaveLength(0);
    });

    it("completes once, kills every session and refresh token, and cannot be replayed", async () => {
      const actor = await signUp(app);
      const other = await signIn(app, actor.email, PASSWORD);
      const otherBody = other.json() as { accessToken: string; refreshToken: string };

      await app.inject({
        method: "POST",
        url: "/api/v1/auth/password-reset",
        payload: { email: actor.email },
      });
      // The token is readable only where it was minted; the test reads the row
      // the way an attacker cannot — it holds a digest, so we re-mint the raw
      // value by asking the transport what it composed.
      const token = await resetTokenFor(app, actor.email);

      const done = await app.inject({
        method: "POST",
        url: "/api/v1/auth/password-reset/complete",
        payload: { token, password: NEW_PASSWORD },
      });
      expect(done.statusCode).toBe(200);
      expect(done.json().sessionsRevoked).toBeGreaterThanOrEqual(2);

      // every access token minted before the reset is refused immediately
      for (const bearer of [actor.accessToken, otherBody.accessToken]) {
        const res = await app.inject({
          method: "GET",
          url: "/api/v1/account/sessions",
          headers: { authorization: `Bearer ${bearer}` },
        });
        expect(res.statusCode).toBe(401);
      }
      // and so is every refresh token
      for (const refresh of [actor.refreshToken, otherBody.refreshToken]) {
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/auth/refresh",
          payload: { refreshToken: refresh },
        });
        expect(res.statusCode).toBe(401);
      }

      expect((await signIn(app, actor.email, NEW_PASSWORD)).statusCode).toBe(200);
      const replay = await app.inject({
        method: "POST",
        url: "/api/v1/auth/password-reset/complete",
        payload: { token, password: "another-valid-passphrase" },
      });
      expect(replay.statusCode).toBe(400);
    });

    it("refuses an expired token and a superseded one", async () => {
      const actor = await signUp(app);
      await app.inject({
        method: "POST",
        url: "/api/v1/auth/password-reset",
        payload: { email: actor.email },
      });
      const first = await resetTokenFor(app, actor.email);
      await app.db
        .update(passwordResets)
        .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
        .where(eq(passwordResets.tokenHash, hashToken(first)));
      const expired = await app.inject({
        method: "POST",
        url: "/api/v1/auth/password-reset/complete",
        payload: { token: first, password: NEW_PASSWORD },
      });
      expect(expired.statusCode).toBe(400);

      // a second request supersedes the first
      await app.inject({
        method: "POST",
        url: "/api/v1/auth/password-reset",
        payload: { email: actor.email },
      });
      const second = await resetTokenFor(app, actor.email);
      expect(second).not.toBe(first);
      const superseded = await app.inject({
        method: "POST",
        url: "/api/v1/auth/password-reset/complete",
        payload: { token: first, password: NEW_PASSWORD },
      });
      expect(superseded.statusCode).toBe(400);
      const current = await app.inject({
        method: "POST",
        url: "/api/v1/auth/password-reset/complete",
        payload: { token: second, password: NEW_PASSWORD },
      });
      expect(current.statusCode).toBe(200);
    });

    it("does not spend the token on a password the policy refuses", async () => {
      const actor = await signUp(app);
      await app.inject({
        method: "POST",
        url: "/api/v1/auth/password-reset",
        payload: { email: actor.email },
      });
      const token = await resetTokenFor(app, actor.email);
      const weak = await app.inject({
        method: "POST",
        url: "/api/v1/auth/password-reset/complete",
        payload: { token, password: "password1234" },
      });
      expect(weak.statusCode).toBe(400);
      expect(weak.json().details.reasons.length).toBeGreaterThan(0);
      // the link still works, which is the point
      const ok = await app.inject({
        method: "POST",
        url: "/api/v1/auth/password-reset/complete",
        payload: { token, password: NEW_PASSWORD },
      });
      expect(ok.statusCode).toBe(200);
    });

    it("throttles silently: the fourth request in an hour changes nothing and says nothing", async () => {
      const actor = await signUp(app);
      const ask = () =>
        app.inject({
          method: "POST",
          url: "/api/v1/auth/password-reset",
          payload: { email: actor.email },
        });
      const bodies: string[] = [];
      for (let i = 0; i < 4; i += 1) bodies.push((await ask()).body);
      expect(new Set(bodies).size).toBe(1);
      const rows = await app.db
        .select()
        .from(passwordResets)
        .where(eq(passwordResets.email, actor.email));
      expect(rows).toHaveLength(3);
    });
  });

  /* ================================================================ */
  describe("the account-security feed", () => {
    it("shows the account's own events, including what failed", async () => {
      const actor = await signUp(app);
      await signIn(app, actor.email, "wrong-password-entirely");
      await signIn(app, actor.email, PASSWORD);
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/account/security-events",
        headers: actor.headers,
      });
      expect(res.statusCode).toBe(200);
      const kinds = (res.json() as { items: { kind: string }[] }).items.map((i) => i.kind);
      expect(kinds).toContain("register");
      expect(kinds).toContain("login_success");
      expect(kinds).toContain("login_failure");
      // nothing in the trail is ever a credential
      expect(res.body).not.toContain(PASSWORD);
    });
  });
});

/**
 * Read back the raw reset token.
 *
 * There is deliberately no API that hands it over — that is the property under
 * test — so this reaches into the no-op transport's outbox, which is the one
 * place the composed message survives, and which only exists because no
 * transport is configured.
 */
async function resetTokenFor(app: FastifyInstance, email: string): Promise<string> {
  const { emailTransportFor } = await import("./mailer.js");
  const transport = emailTransportFor(app) as unknown as {
    recorded: () => { to: { email: string }; text: string; template: string | null }[];
  };
  const message = [...transport.recorded()]
    .reverse()
    .find((m) => m.to.email === email && m.template === "password_reset");
  if (!message) throw new Error(`no password_reset message composed for ${email}`);
  const match = message.text.match(/reset-password\?token=([^\s]+)/);
  if (!match?.[1]) throw new Error("no reset link in the composed message");
  return match[1];
}
