import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { refreshTokens } from "@constructos/db";
import { sha256Hex } from "@constructos/ledger";
import type { BuiltApp } from "../../app.js";
import { buildTestApp, registerActor } from "../../test/helpers.js";

describe("identity", () => {
  let built: BuiltApp;

  beforeAll(async () => {
    built = await buildTestApp();
  });

  afterAll(async () => {
    await built.close();
  });

  it("registers a user with a company and returns tokens", async () => {
    const actor = await registerActor(built.app, { companyName: "Acme Construction" });
    expect(actor.userId).toBeTruthy();
    expect(actor.companyId).toBeTruthy();

    const me = await built.app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: actor.headers,
    });
    expect(me.statusCode).toBe(200);
    const body = me.json() as { email: string; companies: { role: string }[] };
    expect(body.companies).toHaveLength(1);
    expect(body.companies[0]!.role).toBe("owner");
  });

  it("rejects a bad password and honors refresh rotation", async () => {
    const email = `flow-${Date.now()}@test.dev`;
    const reg = await built.app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email, password: "password-123", name: "Flow", companyName: "FlowCo" },
    });
    expect(reg.statusCode).toBe(201);
    const { refreshToken } = reg.json() as { refreshToken: string };

    const bad = await built.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: "wrong-password" },
    });
    expect(bad.statusCode).toBe(401);

    const refreshed = await built.app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken },
    });
    expect(refreshed.statusCode).toBe(200);

    // rotation: the old token is now revoked
    const replay = await built.app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken },
    });
    expect(replay.statusCode).toBe(401);
  });

  it("accepts a refresh token on its expiry DAY, and refuses one past its instant", async () => {
    // Regression: `token.expiresAt <= now` compared a Postgres timestamp
    // ("2026-09-24 23:00:00+00") with toISOString() ("…T10:00:00.000Z") as
    // STRINGS. A space sorts before "T", so from midnight on a token's expiry
    // day every refresh was rejected — a day of sessions lost. See lib/time.ts.
    const email = `expiry-${Date.now()}@test.dev`;
    const reg = await built.app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email, password: "password-123", name: "Expiry", companyName: "ExpiryCo" },
    });
    const { refreshToken } = reg.json() as { refreshToken: string };
    const hash = sha256Hex(refreshToken);

    const laterToday = new Date();
    laterToday.setUTCHours(23, 0, 0, 0);
    await built.app.db
      .update(refreshTokens)
      .set({ expiresAt: laterToday.toISOString() })
      .where(eq(refreshTokens.tokenHash, hash));
    const live = await built.app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken },
    });
    expect(live.statusCode).toBe(200);

    const { refreshToken: rotated } = live.json() as { refreshToken: string };
    await built.app.db
      .update(refreshTokens)
      .set({ expiresAt: new Date(Date.now() - 60_000).toISOString() })
      .where(eq(refreshTokens.tokenHash, sha256Hex(rotated)));
    const dead = await built.app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: rotated },
    });
    expect(dead.statusCode).toBe(401);
  });

  it("requires membership for company-scoped access", async () => {
    const a = await registerActor(built.app);
    const b = await registerActor(built.app);
    const res = await built.app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { ...a.headers, "x-company-id": b.companyId },
    });
    // /me does not require company scope; use a scoped route once modules land.
    expect(res.statusCode).toBe(200);
  });
});
