import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  authSecurityEvents,
  companyMemberships,
  emailDispatches,
  ledgerEntries,
} from "@constructos/db";
import type { BuiltApp } from "../../app.js";
import { buildTestApp } from "../../test/helpers.js";
import { applyRetention, PSEUDONYM } from "./retention.js";

/**
 * DATA LIFECYCLE FOR THE AUTHENTICATION RECORD (§0.2 #45, #46, #47).
 *
 * The three refusals are the point of the suite: a tenant that has chosen no
 * retention loses nothing, a tenant on legal hold loses nothing AND is told
 * why, and an export never carries a credential.
 */

/**
 * Booting PGlite and replaying every migration is minutes of CPU on a shared
 * machine, so the two suites in this file share ONE app and the hook is given
 * five minutes. Isolation comes from each test registering its own tenant,
 * which is what these assertions actually depend on.
 */
const HOOK_TIMEOUT_MS = 300_000;

/**
 * Almost every test here registers one or two accounts, and a registration is
 * a bcrypt hash plus a company, a membership and a project. On a loaded
 * machine two of those alone outrun vitest's 30-second default, which fails
 * the suite for a reason that has nothing to do with retention. The allowance
 * changes no assertion.
 */
vi.setConfig({ testTimeout: 120_000, hookTimeout: HOOK_TIMEOUT_MS });

let built: BuiltApp;
let app: FastifyInstance;

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
}, HOOK_TIMEOUT_MS);
afterAll(async () => built.close());

const PASSWORD = "quarry-lantern-gravel";
let counter = 0;

interface Actor {
  userId: string;
  email: string;
  companyId: string;
  headers: Record<string, string>;
}

async function signUp(app: FastifyInstance): Promise<Actor> {
  counter += 1;
  const email = `ret${counter}-${Date.now()}@test.dev`;
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: {
      email,
      password: PASSWORD,
      name: `Retention User ${counter}`,
      companyName: `Retention Co ${counter}`,
    },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as { user: { id: string }; company: { id: string }; accessToken: string };
  return {
    userId: body.user.id,
    email,
    companyId: body.company.id,
    headers: {
      authorization: `Bearer ${body.accessToken}`,
      "x-company-id": body.company.id,
    },
  };
}

/** An old trail row for this tenant, written directly so the age is chosen. */
async function plantTrailRow(app: FastifyInstance, actor: Actor, ageDays: number): Promise<string> {
  const id = `ase-test-${counter}-${Math.random().toString(16).slice(2)}`;
  await app.db.insert(authSecurityEvents).values({
    id,
    companyId: actor.companyId,
    userId: actor.userId,
    email: actor.email,
    kind: "login_failure",
    outcome: "failure",
    ip: "203.0.113.9",
    userAgent: "test-agent/1.0",
    reason: "planted",
    at: new Date(Date.now() - ageDays * 86_400_000).toISOString(),
  });
  return id;
}

async function plantDispatch(app: FastifyInstance, actor: Actor, ageDays: number): Promise<string> {
  const id = `edp-test-${counter}-${Math.random().toString(16).slice(2)}`;
  await app.db.insert(emailDispatches).values({
    id,
    companyId: actor.companyId,
    userId: actor.userId,
    template: "verify_email",
    toEmail: actor.email,
    subject: "planted",
    status: "recorded",
    transport: "none",
    createdAt: new Date(Date.now() - ageDays * 86_400_000).toISOString(),
  });
  return id;
}

describe("authentication-record retention (§0.2 #46, #47)", () => {
  it("keeps everything for a tenant that has chosen no retention", async () => {
    const actor = await signUp(app);
    const rowId = await plantTrailRow(app, actor, 400);
    const outcome = await applyRetention(app.db, actor.companyId);
    expect(outcome.skipped).toBe(true);
    expect(outcome.reason).toContain("no retention period");
    const [row] = await app.db
      .select()
      .from(authSecurityEvents)
      .where(eq(authSecurityEvents.id, rowId));
    expect(row?.email).toBe(actor.email);
    expect(row?.ip).toBe("203.0.113.9");
  });

  it("pseudonymises trail rows past the retention period and keeps the countable facts", async () => {
    const actor = await signUp(app);
    const oldId = await plantTrailRow(app, actor, 400);
    const freshId = await plantTrailRow(app, actor, 1);
    const put = await app.inject({
      method: "PUT",
      url: "/api/v1/company/security-policy",
      headers: actor.headers,
      payload: { securityEventRetentionDays: 90 },
    });
    expect(put.statusCode).toBe(200);

    const outcome = await applyRetention(app.db, actor.companyId);
    expect(outcome.skipped).toBe(false);
    expect(outcome.securityEventsPseudonymised).toBeGreaterThanOrEqual(1);

    const [old] = await app.db
      .select()
      .from(authSecurityEvents)
      .where(eq(authSecurityEvents.id, oldId));
    expect(old?.email).toBe(PSEUDONYM);
    expect(old?.ip).toBeNull();
    expect(old?.userAgent).toBeNull();
    // The countable facts survive: this is pseudonymisation, not deletion.
    expect(old?.kind).toBe("login_failure");
    expect(old?.outcome).toBe("failure");

    const [fresh] = await app.db
      .select()
      .from(authSecurityEvents)
      .where(eq(authSecurityEvents.id, freshId));
    expect(fresh?.email).toBe(actor.email);
  });

  it("is idempotent: a second run finds nothing left to do", async () => {
    const actor = await signUp(app);
    await plantTrailRow(app, actor, 400);
    await app.inject({
      method: "PUT",
      url: "/api/v1/company/security-policy",
      headers: actor.headers,
      payload: { securityEventRetentionDays: 30 },
    });
    const first = await applyRetention(app.db, actor.companyId);
    expect(first.securityEventsPseudonymised).toBeGreaterThanOrEqual(1);
    const second = await applyRetention(app.db, actor.companyId);
    expect(second.securityEventsPseudonymised).toBe(0);
  });

  it("deletes the message log past its own retention period", async () => {
    const actor = await signUp(app);
    const oldId = await plantDispatch(app, actor, 400);
    const freshId = await plantDispatch(app, actor, 2);
    await app.inject({
      method: "PUT",
      url: "/api/v1/company/security-policy",
      headers: actor.headers,
      payload: { emailDispatchRetentionDays: 90 },
    });
    const outcome = await applyRetention(app.db, actor.companyId);
    expect(outcome.emailDispatchesDeleted).toBeGreaterThanOrEqual(1);
    const remaining = await app.db
      .select({ id: emailDispatches.id })
      .from(emailDispatches)
      .where(eq(emailDispatches.companyId, actor.companyId));
    const ids = remaining.map((r) => r.id);
    expect(ids).not.toContain(oldId);
    expect(ids).toContain(freshId);
  });

  it("a legal hold beats the retention policy and says so", async () => {
    const actor = await signUp(app);
    const rowId = await plantTrailRow(app, actor, 400);
    await app.inject({
      method: "PUT",
      url: "/api/v1/company/security-policy",
      headers: actor.headers,
      payload: {
        securityEventRetentionDays: 30,
        legalHold: true,
        legalHoldReason: "Adjudication 2026/114 — preserve everything",
      },
    });
    const outcome = await applyRetention(app.db, actor.companyId);
    expect(outcome.skipped).toBe(true);
    expect(outcome.reason).toContain("Adjudication 2026/114");
    expect(outcome.securityEventsPseudonymised).toBe(0);
    const [row] = await app.db
      .select()
      .from(authSecurityEvents)
      .where(eq(authSecurityEvents.id, rowId));
    expect(row?.email).toBe(actor.email);
  });

  it("the manual run is admin-only, ledgered, and refused across tenants", async () => {
    const actor = await signUp(app);
    const stranger = await signUp(app);
    await plantTrailRow(app, actor, 400);
    await app.inject({
      method: "PUT",
      url: "/api/v1/company/security-policy",
      headers: actor.headers,
      payload: { securityEventRetentionDays: 30 },
    });

    // A second company cannot run this company's retention: `x-company-id`
    // names a tenant it does not belong to, so the gate refuses before the
    // handler ever sees a companyId.
    const cross = await app.inject({
      method: "POST",
      url: "/api/v1/company/security/retention/run",
      headers: { authorization: stranger.headers["authorization"]!, "x-company-id": actor.companyId },
    });
    expect([401, 403]).toContain(cross.statusCode);

    const run = await app.inject({
      method: "POST",
      url: "/api/v1/company/security/retention/run",
      headers: actor.headers,
    });
    expect(run.statusCode).toBe(200);
    const body = run.json() as { securityEventsPseudonymised: number; reasons: string[] };
    expect(body.securityEventsPseudonymised).toBeGreaterThanOrEqual(1);
    expect(body.reasons.join(" ")).toContain("removed");

    const entries = await app.db
      .select({ objectType: ledgerEntries.objectType })
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.companyId, actor.companyId),
          eq(ledgerEntries.objectType, "auth_retention_run"),
        ),
      );
    expect(entries.length).toBeGreaterThanOrEqual(1);
  });

  it("an ordinary member cannot run retention", async () => {
    const actor = await signUp(app);
    const member = await signUp(app);
    await app.db.insert(companyMemberships).values({
      id: `cm-ret-${counter}-${Date.now()}`,
      companyId: actor.companyId,
      userId: member.userId,
      role: "member",
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/company/security/retention/run",
      headers: { authorization: member.headers["authorization"]!, "x-company-id": actor.companyId },
    });
    expect(res.statusCode).toBe(403);
  });

  it("registers the retention sweep with the platform scheduler", async () => {
    const names = app.scheduler.list().map((j) => j.name);
    expect(names).toContain("account.trail-retention");
    const result = await app.scheduler.runNow("account.trail-retention");
    expect(result).toBeDefined();
  });
});

describe("data-subject export (§0.2 #45)", () => {
  it("returns the account's own record and never a credential", async () => {
    const actor = await signUp(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/account/export",
      headers: actor.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      subject: { email: string } | null;
      memberships: Array<{ companyId: string }>;
      sessions: unknown[];
      securityTrail: unknown[];
      excluded: string[];
    };
    expect(body.subject?.email).toBe(actor.email);
    expect(body.memberships.map((m) => m.companyId)).toContain(actor.companyId);
    expect(body.securityTrail.length).toBeGreaterThan(0);
    expect(body.excluded.length).toBeGreaterThan(0);

    // The rule the export exists to keep: no credential material, anywhere.
    const raw = res.body;
    expect(raw).not.toContain("passwordHash");
    expect(raw).not.toContain("secretCiphertext");
    expect(raw).not.toContain("tokenHash");
    expect(raw).not.toContain("refreshToken");
    expect(raw).not.toContain(PASSWORD);
  });

  it("exports only the caller's own record", async () => {
    const actor = await signUp(app);
    const stranger = await signUp(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/account/export",
      headers: stranger.headers,
    });
    const body = res.json() as { subject: { email: string } | null };
    expect(body.subject?.email).toBe(stranger.email);
    expect(body.subject?.email).not.toBe(actor.email);
  });

  it("refuses an unauthenticated export", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/account/export" });
    expect(res.statusCode).toBe(401);
  });

  it("records the export in the trail and the ledger", async () => {
    const actor = await signUp(app);
    await app.inject({ method: "GET", url: "/api/v1/account/export", headers: actor.headers });
    const trail = await app.db
      .select({ kind: authSecurityEvents.kind })
      .from(authSecurityEvents)
      .where(
        and(
          eq(authSecurityEvents.userId, actor.userId),
          eq(authSecurityEvents.kind, "account_export"),
        ),
      );
    expect(trail.length).toBeGreaterThanOrEqual(1);
    const entries = await app.db
      .select({ objectType: ledgerEntries.objectType })
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.companyId, actor.companyId),
          eq(ledgerEntries.objectType, "account_export"),
        ),
      );
    expect(entries.length).toBeGreaterThanOrEqual(1);
  });
});
