import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../config.js";
import { buildApp, type BuiltApp } from "../app.js";

/**
 * Build an app instance against an in-memory PGlite database and a temp
 * storage dir. Each call is fully isolated — safe for parallel test files.
 */
export async function buildTestApp(): Promise<BuiltApp> {
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "",
    STORAGE_DIR: mkdtempSync(path.join(tmpdir(), "constructos-storage-")),
    AUTH_SECRET: "test-secret-test-secret-test-secret",
    LOG_LEVEL: "silent",
  });
  // loadConfig treats empty string as set; drop it so PGlite is used
  config.DATABASE_URL = undefined;
  return buildApp({ config, logger: false });
}

export interface TestActor {
  userId: string;
  companyId: string;
  accessToken: string;
  headers: Record<string, string>;
}

let counter = 0;

/** Register a user + company and return ready-to-use auth headers. */
export async function registerActor(
  app: FastifyInstance,
  options: { companyName?: string } = {},
): Promise<TestActor> {
  counter += 1;
  const email = `user${counter}-${Date.now()}@test.dev`;
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: {
      email,
      password: "password-123",
      name: `Test User ${counter}`,
      companyName: options.companyName ?? `Test Co ${counter}`,
    },
  });
  if (res.statusCode !== 201) {
    throw new Error(`registerActor failed: ${res.statusCode} ${res.body}`);
  }
  const body = res.json() as {
    user: { id: string };
    company: { id: string };
    accessToken: string;
  };
  return {
    userId: body.user.id,
    companyId: body.company.id,
    accessToken: body.accessToken,
    headers: {
      authorization: `Bearer ${body.accessToken}`,
      "x-company-id": body.company.id,
    },
  };
}
