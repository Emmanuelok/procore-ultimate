/**
 * The front door's audit findings: refresh-token reuse, a trail that reported
 * refused sign-ins as successes, and the tenant "require SSO" switch that was
 * never enforced on the password route.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { authEvents, companyMemberships, identityProviders, users } from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import type { BuiltApp } from "../../app.js";
import { newId } from "../../lib/ids.js";

let built: BuiltApp;
let app: FastifyInstance;
let owner: TestActor;

const PASSWORD = "password-123";

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  owner = await registerActor(app, { companyName: "Identity Co" });
});

afterAll(async () => {
  await built.close();
});

async function registerFresh(companyName?: string) {
  const email = `id-${newId().slice(0, 10)}@test.dev`;
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email, password: PASSWORD, name: "Front Door", companyName },
  });
  expect(res.statusCode).toBe(201);
  return { email, ...(res.json() as { user: { id: string }; refreshToken: string; company: { id: string } | null }) };
}

async function latestAuthEvent(userId: string) {
  const rows = await app.db
    .select()
    .from(authEvents)
    .where(eq(authEvents.userId, userId))
    .orderBy(desc(authEvents.at))
    .limit(5);
  return rows;
}

describe("POST /auth/refresh", () => {
  it("rotates once and treats a replay as reuse, revoking the family", async () => {
    const account = await registerFresh("Refresh Co");
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: account.refreshToken },
    });
    expect(first.statusCode).toBe(200);
    const rotated = first.json().refreshToken as string;

    // Replaying the spent token is, for a single-use credential, reuse.
    const replay = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: account.refreshToken },
    });
    expect(replay.statusCode).toBe(401);

    // ...and the whole family is dead, including the token the legitimate
    // holder just received.
    const afterReuse = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: rotated },
    });
    expect(afterReuse.statusCode).toBe(401);
  });

  it("refuses an unknown token without leaking whether it ever existed", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: "x".repeat(40) },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().message).toBe("Invalid refresh token");
  });
});

describe("the legacy auth trail", () => {
  it("does not record a refused sign-in as a success", async () => {
    const account = await registerFresh("Trail Co");
    // Deactivate: the password is still correct, the sign-in is refused.
    await app.db.update(users).set({ isActive: false }).where(eq(users.id, account.user.id));
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: account.email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(401);

    const events = await latestAuthEvent(account.user.id);
    expect(events[0]!.kind).toBe("login_blocked_inactive");
    expect(events.some((e) => e.kind === "login_success")).toBe(false);
  });

  it("records a wrong password as a failure", async () => {
    const account = await registerFresh("Trail Co 2");
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: account.email, password: "wrong-password-here" },
    });
    const events = await latestAuthEvent(account.user.id);
    expect(events[0]!.kind).toBe("login_failure");
  });

  it("records a completed sign-in as a success", async () => {
    const account = await registerFresh("Trail Co 3");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: account.email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    const events = await latestAuthEvent(account.user.id);
    expect(events[0]!.kind).toBe("login_success");
  });
});

describe("tenant require-SSO policy", () => {
  it("refuses a password sign-in for a member of a company that requires SSO", async () => {
    const account = await registerFresh("SSO Co");
    // A provider that is enabled and forbids password login.
    await app.db.insert(identityProviders).values({
      id: newId("idp"),
      companyId: account.company!.id,
      kind: "oidc",
      displayName: "Corporate IdP",
      slug: `corp-${newId().slice(0, 8)}`,
      isEnabled: true,
      allowPasswordLogin: false,
      createdBy: account.user.id,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: account.email, password: PASSWORD },
    });
    // The uniform refusal, not a different message that would map the tenant.
    expect(res.statusCode).toBe(401);
    expect(res.json().message).toBe("Invalid credentials");

    const events = await latestAuthEvent(account.user.id);
    expect(events.some((e) => e.kind === "login_blocked_password_disabled")).toBe(true);
  });

  it("still allows password sign-in when the provider permits it", async () => {
    const account = await registerFresh("Mixed Co");
    await app.db.insert(identityProviders).values({
      id: newId("idp"),
      companyId: account.company!.id,
      kind: "oidc",
      displayName: "Optional IdP",
      slug: `opt-${newId().slice(0, 8)}`,
      isEnabled: true,
      allowPasswordLogin: true,
      createdBy: account.user.id,
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: account.email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("GET /companies/:companyId", () => {
  it("answers 403 for a non-member rather than 400", async () => {
    const other = await registerActor(app, { companyName: "Someone Else" });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/companies/${owner.companyId}`,
      headers: { authorization: other.headers["authorization"]! },
    });
    expect(res.statusCode).toBe(403);
  });

  it("returns the company to a member", async () => {
    const joiner = await registerActor(app);
    await app.db.insert(companyMemberships).values({
      id: newId("cm"),
      companyId: owner.companyId,
      userId: joiner.userId,
      role: "member",
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/companies/${owner.companyId}`,
      headers: { authorization: joiner.headers["authorization"]! },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(owner.companyId);
  });
});

describe("company slug allocation", () => {
  it("gives two companies with the same name distinct slugs instead of failing", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/companies",
      headers: { authorization: owner.headers["authorization"]! },
      payload: { name: "Duplicate Name Ltd" },
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/companies",
      headers: { authorization: owner.headers["authorization"]! },
      payload: { name: "Duplicate Name Ltd" },
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(first.json().slug).not.toBe(second.json().slug);
  });
});

describe("auth-event register scoping", () => {
  it("does not show one tenant's admins the sign-ins a shared user made in another", async () => {
    // A user in two companies: their sign-ins must not appear in both registers.
    const shared = await registerActor(app);
    await app.db.insert(companyMemberships).values({
      id: newId("cm"),
      companyId: owner.companyId,
      userId: shared.userId,
      role: "member",
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/company/auth-events?userId=${shared.userId}`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<{ at: string; scoped: boolean }>;
    // Their registration predates the membership in THIS company, so it is
    // excluded by the time bound rather than shown to the wrong admins.
    const membership = await app.db
      .select({ createdAt: companyMemberships.createdAt })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, owner.companyId),
          eq(companyMemberships.userId, shared.userId),
        ),
      );
    for (const item of items) {
      if (!item.scoped) expect(item.at > membership[0]!.createdAt).toBe(true);
    }
  });
});
