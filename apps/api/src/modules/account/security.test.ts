import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  authSecurityEvents,
  authSessions,
  companyMemberships,
  companySecurityPolicies,
  securityWebhookDeliveries,
  securityWebhooks,
  users,
} from "@constructos/db";
import type { BuiltApp } from "../../app.js";
import { buildTestApp } from "../../test/helpers.js";
import { attemptDelivery, sweepSecurityWebhooks, type Fetcher } from "./webhooks.js";
import { guardCompanyIpAccess } from "./login.js";

/**
 * How long a suite may take to boot its own embedded Postgres.
 *
 * `buildTestApp()` starts PGlite (WASM) and replays every migration from 0000,
 * which is seconds of CPU on an idle machine and a great deal more on a shared
 * one. Vitest's 30-second default hook timeout therefore fails these suites for
 * a reason that has nothing to do with the code under test — and a suite that
 * fails when the machine is busy teaches people to ignore red, which is the
 * expensive failure. The assertions are unaffected: a hook that is going to
 * succeed still succeeds, it is simply allowed to take longer.
 */
const HOOK_TIMEOUT_MS = 180_000;


/**
 * The tenant security policy, the login audit, administered access, SCIM and
 * security webhooks — through the real routes.
 *
 * The tests that matter most are the refusals: a second company cannot read or
 * change this one's policy, an admin cannot deactivate themselves or an owner,
 * an allowlist that would lock the caller out is refused before it is saved,
 * and a SCIM token issued for one tenant sees exactly one tenant.
 */

const PASSWORD = "scaffold-tower-brick";
let counter = 0;

interface Actor {
  userId: string;
  email: string;
  companyId: string;
  accessToken: string;
  headers: Record<string, string>;
}

async function signUp(app: FastifyInstance, password = PASSWORD): Promise<Actor> {
  counter += 1;
  const email = `sec${counter}-${Date.now()}@test.dev`;
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: {
      email,
      password,
      name: `Sec User ${counter}`,
      companyName: `Sec Co ${counter}`,
    },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as {
    user: { id: string };
    company: { id: string };
    accessToken: string;
  };
  return {
    userId: body.user.id,
    email,
    companyId: body.company.id,
    accessToken: body.accessToken,
    headers: {
      authorization: `Bearer ${body.accessToken}`,
      "x-company-id": body.company.id,
    },
  };
}

/** A second member of an existing company, with a chosen role. */
async function addMember(
  app: FastifyInstance,
  companyId: string,
  role: "owner" | "admin" | "member",
): Promise<Actor> {
  const outsider = await signUp(app);
  await app.db.insert(companyMemberships).values({
    id: `cm-${counter}-${Date.now()}`,
    companyId,
    userId: outsider.userId,
    role,
  });
  return {
    ...outsider,
    companyId,
    headers: { authorization: `Bearer ${outsider.accessToken}`, "x-company-id": companyId },
  };
}

describe("tenant security policy", () => {
  let built: BuiltApp;
  let app: FastifyInstance;

  beforeAll(async () => {
    built = await buildTestApp();
    app = built.app;
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await built.close();
  });

  it("reports the platform defaults, and says nobody has chosen anything", async () => {
    const actor = await signUp(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/company/security-policy",
      headers: actor.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      effective: { passwordMinLength: number; sessionAbsoluteTimeoutHours: number };
      stored: { updatedAt: string | null };
      reasons: string[];
    };
    expect(body.effective.passwordMinLength).toBe(12);
    expect(body.effective.sessionAbsoluteTimeoutHours).toBe(720);
    expect(body.stored.updatedAt).toBeNull();
    expect(body.reasons[0]).toContain("platform defaults");
  });

  it("stores what an admin sets, ledgers it, and records the trail row", async () => {
    const actor = await signUp(app);
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/company/security-policy",
      headers: actor.headers,
      payload: {
        sessionIdleTimeoutMinutes: 30,
        sessionAbsoluteTimeoutHours: 12,
        passwordMinLength: 16,
        passwordRequireComplexity: true,
        passwordHistoryDepth: 3,
        lockoutMaxAttempts: 3,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { effective: { passwordMinLength: number } };
    expect(body.effective.passwordMinLength).toBe(16);

    const [row] = await app.db
      .select()
      .from(companySecurityPolicies)
      .where(eq(companySecurityPolicies.companyId, actor.companyId));
    expect(row?.passwordMinLength).toBe(16);
    expect(row?.updatedBy).toBe(actor.userId);

    const events = await app.db
      .select()
      .from(authSecurityEvents)
      .where(
        and(
          eq(authSecurityEvents.companyId, actor.companyId),
          eq(authSecurityEvents.kind, "security_policy_changed"),
        ),
      );
    expect(events.length).toBeGreaterThan(0);
  });

  it("refuses an allowlist entry that does not parse, naming it", async () => {
    const actor = await signUp(app);
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/company/security-policy",
      headers: actor.headers,
      payload: { ipAllowlistMode: "monitor", ipAllowlist: ["10.0.0.0/8", "not-an-address"] },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toContain("not-an-address");
  });

  it("refuses to enforce a list that would lock the caller out", async () => {
    const actor = await signUp(app);
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/company/security-policy",
      headers: actor.headers,
      payload: { ipAllowlistMode: "enforce", ipAllowlist: ["198.51.100.0/24"] },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { message: string }).message).toContain("does not include the address");
  });

  it("refuses to enforce an empty list", async () => {
    const actor = await signUp(app);
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/company/security-policy",
      headers: actor.headers,
      payload: { ipAllowlistMode: "enforce", ipAllowlist: [] },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { message: string }).message).toContain("refuse everyone");
  });

  it("allows enforce when the caller's own address is inside the list", async () => {
    const actor = await signUp(app);
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/company/security-policy",
      headers: actor.headers,
      // app.inject reports 127.0.0.1
      payload: { ipAllowlistMode: "enforce", ipAllowlist: ["127.0.0.0/8"] },
    });
    expect(res.statusCode).toBe(200);
  });

  it("refuses a break-glass exemption naming a stranger", async () => {
    const actor = await signUp(app);
    const stranger = await signUp(app);
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/company/security-policy",
      headers: actor.headers,
      payload: { ipAllowlistBreakGlassUserIds: [stranger.userId] },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toContain("not a member of this company");
  });

  it("a plain member may read the policy but not change it", async () => {
    const owner = await signUp(app);
    const member = await addMember(app, owner.companyId, "member");
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/company/security-policy",
          headers: member.headers,
        })
      ).statusCode,
    ).toBe(200);
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/company/security-policy",
      headers: member.headers,
      payload: { passwordMinLength: 20 },
    });
    expect(res.statusCode).toBe(403);
  });

  it("CROSS-TENANT: another company cannot read or change this one's policy", async () => {
    const a = await signUp(app);
    const b = await signUp(app);
    // b presents its own bearer with a's company header
    const headers = { authorization: `Bearer ${b.accessToken}`, "x-company-id": a.companyId };
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/company/security-policy", headers }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/v1/company/security-policy",
          headers,
          payload: { passwordMinLength: 20 },
        })
      ).statusCode,
    ).toBe(403);
    // and a's policy is untouched
    const rows = await app.db
      .select()
      .from(companySecurityPolicies)
      .where(eq(companySecurityPolicies.companyId, a.companyId));
    expect(rows).toHaveLength(0);
  });

  it("turning MFA on through the security policy is visible to the MFA policy route", async () => {
    const actor = await signUp(app);
    const put = await app.inject({
      method: "PUT",
      url: "/api/v1/company/security-policy",
      headers: actor.headers,
      payload: { mfaRequired: true },
    });
    expect(put.statusCode).toBe(200);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/auth/mfa/policy",
      headers: actor.headers,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { required: boolean }).required).toBe(true);
  });
});

describe("password policy enforcement (#25)", () => {
  let built: BuiltApp;
  let app: FastifyInstance;

  beforeAll(async () => {
    built = await buildTestApp();
    app = built.app;
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await built.close();
  });

  it("publishes the tenant's rules to a signed-in caller and the platform's to a stranger", async () => {
    const actor = await signUp(app);
    await app.inject({
      method: "PUT",
      url: "/api/v1/company/security-policy",
      headers: actor.headers,
      payload: { passwordMinLength: 18, passwordRequireComplexity: true },
    });
    const mine = await app.inject({
      method: "GET",
      url: "/api/v1/account/password-policy",
      headers: { authorization: `Bearer ${actor.accessToken}` },
    });
    expect((mine.json() as { minLength: number; scope: string }).minLength).toBe(18);
    expect((mine.json() as { scope: string }).scope).toBe("tenant");

    const anonymous = await app.inject({ method: "GET", url: "/api/v1/account/password-policy" });
    expect((anonymous.json() as { minLength: number; scope: string }).minLength).toBe(12);
    expect((anonymous.json() as { scope: string }).scope).toBe("platform");
  });

  it("refuses a change below the tenant's minimum and names the tenant's number", async () => {
    const actor = await signUp(app);
    await app.inject({
      method: "PUT",
      url: "/api/v1/company/security-policy",
      headers: actor.headers,
      payload: { passwordMinLength: 24 },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/account/password",
      headers: { authorization: `Bearer ${actor.accessToken}` },
      payload: { currentPassword: PASSWORD, newPassword: "gantry-crane-lintel" },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toContain("at least 24 characters");
  });

  it("refuses a change that misses a required character class", async () => {
    const actor = await signUp(app);
    await app.inject({
      method: "PUT",
      url: "/api/v1/company/security-policy",
      headers: actor.headers,
      payload: { passwordRequireComplexity: true },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/account/password",
      headers: { authorization: `Bearer ${actor.accessToken}` },
      payload: { currentPassword: PASSWORD, newPassword: "gantrycranelintel" },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toContain("upper-case");
  });

  it("refuses reuse of a previous password once a history depth is set", async () => {
    const actor = await signUp(app);
    await app.inject({
      method: "PUT",
      url: "/api/v1/company/security-policy",
      headers: actor.headers,
      payload: { passwordHistoryDepth: 2 },
    });
    const auth = { authorization: `Bearer ${actor.accessToken}` };
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/account/password",
      headers: auth,
      payload: {
        currentPassword: PASSWORD,
        newPassword: "gantry-crane-lintel-1",
        signOutOtherDevices: false,
      },
    });
    expect(first.statusCode).toBe(200);

    // Back to the original — retained in history, so refused.
    const reuse = await app.inject({
      method: "POST",
      url: "/api/v1/account/password",
      headers: auth,
      payload: {
        currentPassword: "gantry-crane-lintel-1",
        newPassword: PASSWORD,
        signOutOtherDevices: false,
      },
    });
    expect(reuse.statusCode).toBe(400);
    expect(JSON.stringify(reuse.json())).toContain("refuses the last 2");

    const refusals = await app.db
      .select()
      .from(authSecurityEvents)
      .where(
        and(
          eq(authSecurityEvents.userId, actor.userId),
          eq(authSecurityEvents.kind, "password_reuse_refused"),
        ),
      );
    expect(refusals).toHaveLength(1);

    // A password never used is still accepted.
    const ok = await app.inject({
      method: "POST",
      url: "/api/v1/account/password",
      headers: auth,
      payload: {
        currentPassword: "gantry-crane-lintel-1",
        newPassword: "gantry-crane-lintel-2",
        signOutOtherDevices: false,
      },
    });
    expect(ok.statusCode).toBe(200);
  });

  it("keeps no history at all when the depth is zero", async () => {
    const actor = await signUp(app);
    const auth = { authorization: `Bearer ${actor.accessToken}` };
    await app.inject({
      method: "POST",
      url: "/api/v1/account/password",
      headers: auth,
      payload: {
        currentPassword: PASSWORD,
        newPassword: "gantry-crane-lintel-9",
        signOutOtherDevices: false,
      },
    });
    // Reuse of the original is allowed: no tenant asked for it to be refused.
    const back = await app.inject({
      method: "POST",
      url: "/api/v1/account/password",
      headers: auth,
      payload: {
        currentPassword: "gantry-crane-lintel-9",
        newPassword: PASSWORD,
        signOutOtherDevices: false,
      },
    });
    expect(back.statusCode).toBe(200);
  });
});

describe("session lifetime from policy (#23)", () => {
  let built: BuiltApp;
  let app: FastifyInstance;

  beforeAll(async () => {
    built = await buildTestApp();
    app = built.app;
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await built.close();
  });

  it("bounds a new session by the tenant's absolute lifetime", async () => {
    const actor = await signUp(app);
    await app.inject({
      method: "PUT",
      url: "/api/v1/company/security-policy",
      headers: actor.headers,
      payload: { sessionAbsoluteTimeoutHours: 2 },
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/login",
      payload: { email: actor.email, password: PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    const sessionId = (login.json() as { sessionId: string }).sessionId;
    const [row] = await app.db
      .select()
      .from(authSessions)
      .where(eq(authSessions.id, sessionId));
    const lifetimeMs = Date.parse(row!.expiresAt) - Date.parse(row!.createdAt);
    // two hours, not the platform's thirty days
    expect(lifetimeMs).toBeLessThanOrEqual(2 * 3600_000 + 5_000);
    expect(lifetimeMs).toBeGreaterThan(3600_000);
  });

  /**
   * THE IDLE TIMEOUT ACTUALLY BITES.
   *
   * `sessionIdleTimeoutMinutes` was stored, resolved and shown on the policy
   * page, and nothing read it on the request path — a tenant that set "sign
   * people out after 15 minutes" got a setting, not a behaviour. It is now
   * enforced in `requireLiveSession` (modules/account/sessions.ts), before
   * `last_seen_at` is refreshed: refreshing first would reset the very clock
   * the check reads and the timeout would never fire for anyone with a tab
   * open.
   */
  it("signs an idle session out, revokes the row, and records why", async () => {
    const actor = await signUp(app);
    await app.inject({
      method: "PUT",
      url: "/api/v1/company/security-policy",
      headers: actor.headers,
      payload: { sessionIdleTimeoutMinutes: 15 },
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/login",
      payload: { email: actor.email, password: PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    const body = login.json() as { sessionId: string; accessToken: string };
    const headers = { authorization: `Bearer ${body.accessToken}` };

    // Still active: the device list answers.
    expect((await app.inject({ method: "GET", url: "/api/v1/account/sessions", headers })).statusCode)
      .toBe(200);

    // Now make it idle. Backdating `last_seen_at` is the only honest way to
    // test a clock without faking one.
    await app.db
      .update(authSessions)
      .set({ lastSeenAt: new Date(Date.now() - 40 * 60_000).toISOString() })
      .where(eq(authSessions.id, body.sessionId));

    const after = await app.inject({ method: "GET", url: "/api/v1/account/sessions", headers });
    expect(after.statusCode).toBe(401);
    expect((after.json() as { message: string }).message).toContain("inactivity");

    const [row] = await app.db
      .select()
      .from(authSessions)
      .where(eq(authSessions.id, body.sessionId));
    expect(row!.revokedAt).toBeTruthy();

    const events = await app.db
      .select()
      .from(authSecurityEvents)
      .where(
        and(
          eq(authSecurityEvents.userId, actor.userId),
          eq(authSecurityEvents.kind, "session_idle_timeout"),
        ),
      );
    expect(events).toHaveLength(1);
  });

  it("leaves an idle session alone when no tenant asks for a timeout", async () => {
    const actor = await signUp(app);
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/login",
      payload: { email: actor.email, password: PASSWORD },
    });
    const body = login.json() as { sessionId: string; accessToken: string };
    await app.db
      .update(authSessions)
      .set({ lastSeenAt: new Date(Date.now() - 40 * 24 * 3600_000).toISOString() })
      .where(eq(authSessions.id, body.sessionId));
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/account/sessions",
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("IP allowlisting at sign-in (#24)", () => {
  let built: BuiltApp;
  let app: FastifyInstance;

  beforeAll(async () => {
    built = await buildTestApp();
    app = built.app;
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await built.close();
  });

  it("refuses a correct password from an address no tenant of the account allows", async () => {
    const actor = await signUp(app);
    // Set the list directly: the route refuses to lock its own caller out,
    // which is the behaviour the previous suite proves.
    await app.db.insert(companySecurityPolicies).values({
      id: `secpol-${Date.now()}`,
      companyId: actor.companyId,
      ipAllowlistMode: "enforce",
      ipAllowlist: ["198.51.100.0/24"],
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/login",
      payload: { email: actor.email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { message: string }).message).toContain("approved networks");

    const blocked = await app.db
      .select()
      .from(authSecurityEvents)
      .where(
        and(
          eq(authSecurityEvents.userId, actor.userId),
          eq(authSecurityEvents.kind, "login_blocked_ip"),
        ),
      );
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.outcome).toBe("blocked");
  });

  it("monitor mode records the refusal it did not make", async () => {
    const actor = await signUp(app);
    await app.db.insert(companySecurityPolicies).values({
      id: `secpol-m-${Date.now()}`,
      companyId: actor.companyId,
      ipAllowlistMode: "monitor",
      ipAllowlist: ["198.51.100.0/24"],
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/login",
      payload: { email: actor.email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    const rows = await app.db
      .select()
      .from(authSecurityEvents)
      .where(
        and(
          eq(authSecurityEvents.userId, actor.userId),
          eq(authSecurityEvents.kind, "login_blocked_ip"),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe("pending");
  });

  /**
   * THE PER-REQUEST HALF OF #24.
   *
   * Sign-in enforcement (above) refuses only when EVERY company of the account
   * refuses the address, because a contractor working for a strict client and
   * a relaxed one must still be able to work for the relaxed one. That leaves
   * the strict tenant's own rule to be applied on the request that names it —
   * `guardCompanyIpAccess`, which `requireCompany` calls (see the diff in the
   * WP-AUTH report; plugins/auth.ts is not this package's to edit). These
   * tests drive the guard directly so its behaviour is fixed before the wiring
   * lands, and so the wiring cannot silently change it afterwards.
   */
  describe("guardCompanyIpAccess", () => {
    const reqFrom = (ip: string) =>
      ({ ip, headers: {}, url: "/api/v1/projects" }) as unknown as Parameters<
        typeof guardCompanyIpAccess
      >[1];

    it("refuses a request from outside an enforced allowlist and records it", async () => {
      const actor = await signUp(app);
      await app.db.insert(companySecurityPolicies).values({
        id: `secpol-req-${Date.now()}`,
        companyId: actor.companyId,
        ipAllowlistMode: "enforce",
        ipAllowlist: ["198.51.100.0/24"],
      });
      await expect(
        guardCompanyIpAccess(app, reqFrom("203.0.113.9"), actor.companyId, actor.userId),
      ).rejects.toMatchObject({ statusCode: 403 });
      await expect(
        guardCompanyIpAccess(app, reqFrom("198.51.100.7"), actor.companyId, actor.userId),
      ).resolves.toBeUndefined();
      const rows = await app.db
        .select()
        .from(authSecurityEvents)
        .where(
          and(
            eq(authSecurityEvents.companyId, actor.companyId),
            eq(authSecurityEvents.kind, "login_blocked_ip"),
          ),
        );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.outcome).toBe("blocked");
    });

    it("allows and records in monitor mode, and never speaks when the mode is off", async () => {
      const monitored = await signUp(app);
      await app.db.insert(companySecurityPolicies).values({
        id: `secpol-req-m-${Date.now()}`,
        companyId: monitored.companyId,
        ipAllowlistMode: "monitor",
        ipAllowlist: ["198.51.100.0/24"],
      });
      await expect(
        guardCompanyIpAccess(app, reqFrom("203.0.113.9"), monitored.companyId, monitored.userId),
      ).resolves.toBeUndefined();
      const rows = await app.db
        .select()
        .from(authSecurityEvents)
        .where(
          and(
            eq(authSecurityEvents.companyId, monitored.companyId),
            eq(authSecurityEvents.kind, "login_blocked_ip"),
          ),
        );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.outcome).toBe("pending");

      const off = await signUp(app);
      await expect(
        guardCompanyIpAccess(app, reqFrom("203.0.113.9"), off.companyId, off.userId),
      ).resolves.toBeUndefined();
      const none = await app.db
        .select()
        .from(authSecurityEvents)
        .where(
          and(
            eq(authSecurityEvents.companyId, off.companyId),
            eq(authSecurityEvents.kind, "login_blocked_ip"),
          ),
        );
      expect(none).toHaveLength(0);
    });

    it("lets a break-glass user through, so a mistyped CIDR is always fixable", async () => {
      const actor = await signUp(app);
      await app.db.insert(companySecurityPolicies).values({
        id: `secpol-req-bg-${Date.now()}`,
        companyId: actor.companyId,
        ipAllowlistMode: "enforce",
        ipAllowlist: ["198.51.100.0/24"],
        ipAllowlistBreakGlassUserIds: [actor.userId],
      });
      await expect(
        guardCompanyIpAccess(app, reqFrom("203.0.113.9"), actor.companyId, actor.userId),
      ).resolves.toBeUndefined();
    });
  });

  it("a break-glass member still gets in", async () => {
    const actor = await signUp(app);
    await app.db.insert(companySecurityPolicies).values({
      id: `secpol-bg-${Date.now()}`,
      companyId: actor.companyId,
      ipAllowlistMode: "enforce",
      ipAllowlist: ["198.51.100.0/24"],
      ipAllowlistBreakGlassUserIds: [actor.userId],
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/login",
      payload: { email: actor.email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("login audit and export (§0.2)", () => {
  let built: BuiltApp;
  let app: FastifyInstance;

  beforeAll(async () => {
    built = await buildTestApp();
    app = built.app;
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await built.close();
  });

  it("lists this company's rows, filtered, and says what it cannot show", async () => {
    const actor = await signUp(app);
    await app.inject({
      method: "PUT",
      url: "/api/v1/company/security-policy",
      headers: actor.headers,
      payload: { passwordMinLength: 14 },
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/company/security-events?kind=security_policy_changed",
      headers: actor.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ kind: string }>; total: number; reasons: string[] };
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((i) => i.kind === "security_policy_changed")).toBe(true);
    expect(body.reasons[0]).toContain("belongs to no account");
  });

  it("exports CSV with a header row and a download filename", async () => {
    const actor = await signUp(app);
    await app.inject({
      method: "PUT",
      url: "/api/v1/company/security-policy",
      headers: actor.headers,
      payload: { passwordMinLength: 14 },
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/company/security-events/export?format=csv",
      headers: actor.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(String(res.headers["content-disposition"])).toContain("attachment");
    const lines = res.body.split("\n");
    expect(lines[0]).toBe("at,kind,outcome,user_id,email,session_id,provider_id,ip,user_agent,reason");
    expect(lines.length).toBeGreaterThan(1);
  });

  it("exports JSON when asked, with the row count and the bound", async () => {
    const actor = await signUp(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/company/security-events/export?format=json&limit=10",
      headers: actor.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { count: number; limit: number; items: unknown[] };
    expect(body.limit).toBe(10);
    expect(body.count).toBe(body.items.length);
  });

  it("CROSS-TENANT: an admin of another company sees nothing here", async () => {
    const a = await signUp(app);
    const b = await signUp(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/company/security-events",
      headers: { authorization: `Bearer ${b.accessToken}`, "x-company-id": a.companyId },
    });
    expect(res.statusCode).toBe(403);
  });

  it("a plain member cannot read the company audit", async () => {
    const owner = await signUp(app);
    const member = await addMember(app, owner.companyId, "member");
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/company/security-events",
      headers: member.headers,
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("administering a member", () => {
  let built: BuiltApp;
  let app: FastifyInstance;

  beforeAll(async () => {
    built = await buildTestApp();
    app = built.app;
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await built.close();
  });

  it("deactivates a member, kills their sessions, and refuses their next request", async () => {
    const owner = await signUp(app);
    const member = await addMember(app, owner.companyId, "member");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/company/security/users/${member.userId}/deactivate`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { sessionsRevoked: number }).sessionsRevoked).toBeGreaterThanOrEqual(0);

    const [row] = await app.db.select().from(users).where(eq(users.id, member.userId));
    expect(row?.isActive).toBe(false);

    const after = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${member.accessToken}` },
    });
    expect(after.statusCode).toBe(401);
  });

  it("refuses a second deactivation, and reactivates", async () => {
    const owner = await signUp(app);
    const member = await addMember(app, owner.companyId, "member");
    await app.inject({
      method: "POST",
      url: `/api/v1/company/security/users/${member.userId}/deactivate`,
      headers: owner.headers,
    });
    const again = await app.inject({
      method: "POST",
      url: `/api/v1/company/security/users/${member.userId}/deactivate`,
      headers: owner.headers,
    });
    expect(again.statusCode).toBe(409);
    const back = await app.inject({
      method: "POST",
      url: `/api/v1/company/security/users/${member.userId}/reactivate`,
      headers: owner.headers,
    });
    expect(back.statusCode).toBe(200);
  });

  it("refuses to act on yourself", async () => {
    const owner = await signUp(app);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/company/security/users/${owner.userId}/deactivate`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { message: string }).message).toContain("your own account");
  });

  it("an admin may not deactivate an owner", async () => {
    const owner = await signUp(app);
    const admin = await addMember(app, owner.companyId, "admin");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/company/security/users/${owner.userId}/deactivate`,
      headers: admin.headers,
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { message: string }).message).toContain("Only an owner");
  });

  it("CROSS-TENANT: a member of another company is not found here", async () => {
    const a = await signUp(app);
    const b = await signUp(app);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/company/security/users/${b.userId}/deactivate`,
      headers: a.headers,
    });
    expect(res.statusCode).toBe(404);
    const [row] = await app.db.select().from(users).where(eq(users.id, b.userId));
    expect(row?.isActive).toBe(true);
  });

  it("revokes only the sessions opened in this company by default", async () => {
    const owner = await signUp(app);
    const member = await addMember(app, owner.companyId, "member");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/company/security/users/${member.userId}/sessions/revoke`,
      headers: owner.headers,
      payload: { scope: "company" },
    });
    expect(res.statusCode).toBe(200);
    const events = await app.db
      .select()
      .from(authSecurityEvents)
      .where(
        and(
          eq(authSecurityEvents.userId, member.userId),
          eq(authSecurityEvents.kind, "admin_sessions_revoked"),
        ),
      );
    expect(events).toHaveLength(1);
  });

  it("refuses an MFA reset for an account with no factor", async () => {
    const owner = await signUp(app);
    const member = await addMember(app, owner.companyId, "member");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/company/security/users/${member.userId}/mfa/reset`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(409);
  });
});

describe("SCIM 2.0 (#21)", () => {
  let built: BuiltApp;
  let app: FastifyInstance;
  let actor: Actor;
  let token: string;

  beforeAll(async () => {
    built = await buildTestApp();
    app = built.app;
    actor = await signUp(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/company/scim/tokens",
      headers: actor.headers,
      payload: { name: "Okta" },
    });
    expect(res.statusCode).toBe(201);
    token = (res.json() as { token: string }).token;
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await built.close();
  });

  const scim = (method: string, url: string, payload?: unknown) =>
    app.inject({
      method: method as "GET",
      url: `/api/v1/scim/v2${url}`,
      headers: { authorization: `Bearer ${token}` },
      ...(payload === undefined ? {} : { payload }),
    });

  it("refuses without a token, and with a token that is not one", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/scim/v2/Users" })).statusCode).toBe(401);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/scim/v2/Users",
      headers: { authorization: `Bearer ${actor.accessToken}` },
    });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { schemas: string[] }).schemas[0]).toContain("scim:api:messages:2.0:Error");
  });

  it("is mounted at the documented path, once — not behind a doubled prefix", () => {
    // REGRESSION. `registerScimRoutes` is called from inside `accountModule`,
    // which app.ts registers with `{ prefix: "/api/v1" }`. Passing the full
    // public path as the registration path therefore mounted every SCIM route
    // at `/api/v1/api/v1/scim/v2/…`: the documented URL — the one an identity
    // provider is configured with — answered 404, and nothing noticed because
    // the SCIM unit tests only exercised the pure helpers. This asserts the
    // route table itself, so the two constants cannot drift apart again.
    const tree = app.printRoutes({ commonPrefix: false });
    expect(tree).toContain("/api/v1/scim/v2/Users");
    expect(tree).not.toContain("/api/v1/api/v1");
  });

  it("publishes an honest ServiceProviderConfig", async () => {
    const res = await scim("GET", "/ServiceProviderConfig");
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, { supported: boolean }>;
    expect(body["patch"]!.supported).toBe(true);
    expect(body["bulk"]!.supported).toBe(false);
    expect(body["sort"]!.supported).toBe(false);
  });

  it("lists the company's members and nobody else's", async () => {
    const stranger = await signUp(app);
    const res = await scim("GET", "/Users");
    expect(res.statusCode).toBe(200);
    const body = res.json() as { Resources: Array<{ userName: string }> };
    expect(body.Resources.some((r) => r.userName === actor.email)).toBe(true);
    expect(body.Resources.some((r) => r.userName === stranger.email)).toBe(false);
  });

  it("provisions a user, then finds them by userName", async () => {
    const email = `scim-new-${Date.now()}@test.dev`;
    const created = await scim("POST", "/Users", {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      userName: email,
      name: { givenName: "Ada", familyName: "Lovelace" },
      active: true,
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as { id: string; active: boolean; displayName: string };
    expect(body.active).toBe(true);
    expect(body.displayName).toBe("Ada Lovelace");

    const found = await scim("GET", `/Users?filter=${encodeURIComponent(`userName eq "${email}"`)}`);
    expect((found.json() as { totalResults: number }).totalResults).toBe(1);

    // A second create for the same address is a SCIM uniqueness conflict.
    const again = await scim("POST", "/Users", { userName: email });
    expect(again.statusCode).toBe(409);
    expect((again.json() as { scimType: string }).scimType).toBe("uniqueness");
  });

  it("deprovisions with active:false — membership gone, account off, sessions dead", async () => {
    const email = `scim-leaver-${Date.now()}@test.dev`;
    const created = await scim("POST", "/Users", { userName: email });
    const id = (created.json() as { id: string }).id;

    const patched = await scim("PATCH", `/Users/${id}`, {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [{ op: "replace", value: { active: false } }],
    });
    expect(patched.statusCode).toBe(200);
    expect((patched.json() as { active: boolean }).active).toBe(false);

    const memberships = await app.db
      .select()
      .from(companyMemberships)
      .where(eq(companyMemberships.userId, id));
    expect(memberships).toHaveLength(0);
    const [row] = await app.db.select().from(users).where(eq(users.id, id));
    expect(row?.isActive).toBe(false);

    const events = await app.db
      .select()
      .from(authSecurityEvents)
      .where(
        and(eq(authSecurityEvents.userId, id), eq(authSecurityEvents.kind, "scim_user_deactivated")),
      );
    expect(events).toHaveLength(1);
  });

  it("DELETE deprovisions too, and a stranger's id is 404 not 403", async () => {
    const email = `scim-del-${Date.now()}@test.dev`;
    const created = await scim("POST", "/Users", { userName: email });
    const id = (created.json() as { id: string }).id;
    expect((await scim("DELETE", `/Users/${id}`)).statusCode).toBe(204);

    const stranger = await signUp(app);
    const res = await scim("DELETE", `/Users/${stranger.userId}`);
    expect(res.statusCode).toBe(404);
    const [row] = await app.db.select().from(users).where(eq(users.id, stranger.userId));
    expect(row?.isActive).toBe(true);
  });

  it("refuses a filter it cannot honour rather than answering with everybody", async () => {
    const res = await scim("GET", `/Users?filter=${encodeURIComponent("meta.created gt 2024-01-01")}`);
    expect(res.statusCode).toBe(400);
    expect((res.json() as { scimType: string }).scimType).toBe("invalidFilter");
  });

  it("moves a member between role groups, and never removes an owner", async () => {
    const email = `scim-role-${Date.now()}@test.dev`;
    const created = await scim("POST", "/Users", { userName: email });
    const id = (created.json() as { id: string }).id;

    const promote = await scim("PATCH", "/Groups/role:admin", {
      Operations: [{ op: "add", path: "members", value: [{ value: id }] }],
    });
    expect(promote.statusCode).toBe(200);
    const [membership] = await app.db
      .select()
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, actor.companyId),
          eq(companyMemberships.userId, id),
        ),
      );
    expect(membership?.role).toBe("admin");

    // The owner is untouchable from a directory.
    await scim("PATCH", "/Groups/role:owner", {
      Operations: [{ op: "remove", path: "members", value: [{ value: actor.userId }] }],
    });
    const [ownerRow] = await app.db
      .select()
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, actor.companyId),
          eq(companyMemberships.userId, actor.userId),
        ),
      );
    expect(ownerRow?.role).toBe("owner");
  });

  it("a revoked token stops working immediately", async () => {
    const minted = await app.inject({
      method: "POST",
      url: "/api/v1/company/scim/tokens",
      headers: actor.headers,
      payload: { name: "Temporary" },
    });
    const body = minted.json() as { id: string; token: string };
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/scim/v2/Users",
          headers: { authorization: `Bearer ${body.token}` },
        })
      ).statusCode,
    ).toBe(200);
    await app.inject({
      method: "DELETE",
      url: `/api/v1/company/scim/tokens/${body.id}`,
      headers: actor.headers,
    });
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/scim/v2/Users",
          headers: { authorization: `Bearer ${body.token}` },
        })
      ).statusCode,
    ).toBe(401);
  });

  it("never returns the raw token again after creation", async () => {
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/company/scim/tokens",
      headers: actor.headers,
    });
    expect(res200(list)).toBe(true);
    expect(list.body).not.toContain(token);
    expect(list.body).toContain(token.slice(0, 10));
  });
});

function res200(res: { statusCode: number }): boolean {
  return res.statusCode === 200;
}

describe("security event webhooks (§0.2)", () => {
  let built: BuiltApp;
  let app: FastifyInstance;

  beforeAll(async () => {
    built = await buildTestApp();
    app = built.app;
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await built.close();
  });

  it("refuses a destination inside the platform's own network", async () => {
    const actor = await signUp(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/company/security-webhooks",
      headers: actor.headers,
      payload: { name: "Metadata", url: "http://169.254.169.254/latest/meta-data" },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { message: string }).message).toContain("cannot receive webhooks");
  });

  it("creates an endpoint, shows the secret once, and enqueues matching events", async () => {
    const actor = await signUp(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/company/security-webhooks",
      headers: actor.headers,
      payload: {
        name: "SIEM",
        url: "https://siem.example.com/hook",
        eventKinds: ["security_policy_changed"],
      },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as { id: string; secret: string };
    expect(body.secret.startsWith("whsec_")).toBe(true);

    // The secret is never returned again.
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/company/security-webhooks",
      headers: actor.headers,
    });
    expect(list.body).not.toContain(body.secret);

    // A subscribed event queues a delivery; an unsubscribed one does not.
    await app.inject({
      method: "PUT",
      url: "/api/v1/company/security-policy",
      headers: actor.headers,
      payload: { passwordMinLength: 14 },
    });
    const queued = await app.db
      .select()
      .from(securityWebhookDeliveries)
      .where(eq(securityWebhookDeliveries.webhookId, body.id));
    expect(queued.length).toBeGreaterThan(0);
    expect(queued.every((d) => d.eventKind === "security_policy_changed")).toBe(true);
  });

  it("delivers with a signature, and marks the delivery delivered", async () => {
    const actor = await signUp(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/company/security-webhooks",
      headers: actor.headers,
      payload: { name: "SIEM", url: "https://siem.example.com/hook" },
    });
    const webhookId = (created.json() as { id: string }).id;
    const deliveryId = `swd-test-${Date.now()}`;
    await app.db.insert(securityWebhookDeliveries).values({
      id: deliveryId,
      companyId: actor.companyId,
      webhookId,
      eventKind: "login_failure",
      payload: { kind: "login_failure" },
      status: "pending",
      nextAttemptAt: new Date().toISOString(),
    });

    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetcher: Fetcher = async (url, init) => {
      seen.push({ url, headers: (init.headers ?? {}) as Record<string, string> });
      return new Response("", { status: 200 });
    };
    const outcome = await attemptDelivery(app, deliveryId, { fetcher });
    expect(outcome.status).toBe("delivered");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers["x-constructos-signature"]).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(seen[0]!.headers["x-constructos-event"]).toBe("security.login_failure");
    expect(seen[0]!.headers["x-constructos-delivery"]).toBe(deliveryId);

    const [row] = await app.db
      .select()
      .from(securityWebhookDeliveries)
      .where(eq(securityWebhookDeliveries.id, deliveryId));
    expect(row?.status).toBe("delivered");
    expect(row?.deliveredAt).not.toBeNull();
  });

  it("retries a failure with backoff and never reports it delivered", async () => {
    const actor = await signUp(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/company/security-webhooks",
      headers: actor.headers,
      payload: { name: "Broken", url: "https://broken.example.com/hook" },
    });
    const webhookId = (created.json() as { id: string }).id;
    const deliveryId = `swd-fail-${Date.now()}`;
    await app.db.insert(securityWebhookDeliveries).values({
      id: deliveryId,
      companyId: actor.companyId,
      webhookId,
      eventKind: "login_failure",
      payload: {},
      status: "pending",
      nextAttemptAt: new Date().toISOString(),
    });
    const fetcher: Fetcher = async () => new Response("nope", { status: 500 });
    const outcome = await attemptDelivery(app, deliveryId, { fetcher });
    expect(outcome.status).toBe("pending");
    const [row] = await app.db
      .select()
      .from(securityWebhookDeliveries)
      .where(eq(securityWebhookDeliveries.id, deliveryId));
    expect(row?.attempts).toBe(1);
    expect(row?.deliveredAt).toBeNull();
    expect(Date.parse(row!.nextAttemptAt!)).toBeGreaterThan(Date.now());

    const [endpoint] = await app.db
      .select()
      .from(securityWebhooks)
      .where(eq(securityWebhooks.id, webhookId));
    expect(endpoint?.consecutiveFailures).toBe(1);
  });

  it("the sweep only touches deliveries that are due", async () => {
    const actor = await signUp(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/company/security-webhooks",
      headers: actor.headers,
      payload: { name: "Later", url: "https://later.example.com/hook" },
    });
    const webhookId = (created.json() as { id: string }).id;
    // Creating the endpoint is itself a security event (`security_webhook_
    // changed`), so the subscription hook has already queued a delivery that
    // IS due. That is correct behaviour — a SIEM should learn that a new
    // endpoint was registered — but it is not what this test is about, so the
    // queue is emptied before the one delivery under test is planted.
    await app.db
      .delete(securityWebhookDeliveries)
      .where(eq(securityWebhookDeliveries.companyId, actor.companyId));
    await app.db.insert(securityWebhookDeliveries).values({
      id: `swd-later-${Date.now()}`,
      companyId: actor.companyId,
      webhookId,
      eventKind: "login_failure",
      payload: {},
      status: "pending",
      nextAttemptAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    let calls = 0;
    const fetcher: Fetcher = async () => {
      calls += 1;
      return new Response("", { status: 200 });
    };
    const result = await sweepSecurityWebhooks(app, { companyId: actor.companyId, fetcher });
    expect(result.attempted).toBe(0);
    expect(calls).toBe(0);
  });

  it("CROSS-TENANT: another company cannot list, test or delete this one's endpoints", async () => {
    const a = await signUp(app);
    const b = await signUp(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/company/security-webhooks",
      headers: a.headers,
      payload: { name: "Mine", url: "https://mine.example.com/hook" },
    });
    const id = (created.json() as { id: string }).id;
    const bHeaders = { authorization: `Bearer ${b.accessToken}`, "x-company-id": b.companyId };
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/company/security-webhooks",
      headers: bHeaders,
    });
    expect((list.json() as { items: unknown[] }).items).toHaveLength(0);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/v1/company/security-webhooks/${id}`,
          headers: bHeaders,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/company/security-webhooks/${id}/test`,
          headers: bHeaders,
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe("scheduled sweeps", () => {
  let built: BuiltApp;
  let app: FastifyInstance;

  beforeAll(async () => {
    built = await buildTestApp();
    app = built.app;
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await built.close();
  });

  it("registers its jobs with the platform scheduler", async () => {
    const names = app.scheduler.list().map((j) => j.name);
    expect(names).toContain("account.session-sweep");
    expect(names).toContain("account.security-webhooks");
    expect(names).toContain("account.webhook-retention");
  });

  it("the session sweep marks a session past its absolute lifetime", async () => {
    const actor = await signUp(app);
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/login",
      payload: { email: actor.email, password: PASSWORD },
    });
    const sessionId = (login.json() as { sessionId: string }).sessionId;
    await app.db
      .update(authSessions)
      .set({ expiresAt: new Date(Date.now() - 60_000).toISOString() })
      .where(eq(authSessions.id, sessionId));

    await app.scheduler.runNow("account.session-sweep");
    const [row] = await app.db.select().from(authSessions).where(eq(authSessions.id, sessionId));
    expect(row?.revokedAt).not.toBeNull();
    expect(row?.revokedReason).toBe("expired");
  });
});
