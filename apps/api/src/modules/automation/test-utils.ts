/**
 * Shared fixtures for the automation module's tests.
 *
 * The module's app.ts registration line belongs to the orchestrator. Until it
 * lands — and harmlessly once it has — `buildAutomationApp` registers the
 * plugin itself when the scheduler does not already know its jobs, so every
 * test in this directory exercises the real routes, the real ledger hook and
 * the real scheduler jobs against an isolated PGlite database.
 */
import type { FastifyInstance } from "fastify";
import { companyMemberships, projectMemberships } from "@constructos/db";
import { newId } from "../../lib/ids.js";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { getEngine, type AutomationEngine } from "./engine.js";
import { automationModule } from "./index.js";

export const url = (p: string) => `/api/v1${p}`;

export interface AutomationTestApp {
  app: FastifyInstance;
  engine: AutomationEngine;
  close: () => Promise<void>;
}

export async function buildAutomationApp(): Promise<AutomationTestApp> {
  const built = await buildTestApp();
  const app = built.app;
  if (!app.scheduler.has("automation.drain")) {
    await app.register(automationModule, { prefix: "/api/v1" });
  }
  await app.ready();
  const engine = getEngine(app.db);
  if (!engine) throw new Error("automation engine was not registered");
  return { app, engine, close: built.close };
}

export async function createProject(app: FastifyInstance, actor: TestActor, name = "Automation test project"): Promise<string> {
  const res = await app.inject({ method: "POST", url: url("/projects"), headers: actor.headers, payload: { name } });
  if (res.statusCode !== 201) throw new Error(`createProject failed: ${res.statusCode} ${res.body}`);
  return (res.json() as { id: string }).id;
}

/**
 * A second user inside `owner`'s company with the given company role, and
 * optionally a project membership whose automation level is set explicitly
 * (an override, so the test does not depend on what a builtin template says
 * about the tool).
 */
export async function addCompanyMember(
  app: FastifyInstance,
  owner: TestActor,
  role: "admin" | "member" | "guest",
  project?: { projectId: string; automationLevel: "none" | "read" | "standard" | "admin" },
): Promise<TestActor> {
  const actor = await registerActor(app);
  await app.db.insert(companyMemberships).values({ id: newId("cm"), companyId: owner.companyId, userId: actor.userId, role });
  if (project) {
    await app.db.insert(projectMemberships).values({
      id: newId("pm"),
      companyId: owner.companyId,
      projectId: project.projectId,
      userId: actor.userId,
      templateKey: "read_only",
      overrides: { automation: project.automationLevel },
    });
  }
  return {
    ...actor,
    companyId: owner.companyId,
    headers: { authorization: actor.headers["authorization"]!, "x-company-id": owner.companyId },
  };
}

export async function createRfi(
  app: FastifyInstance,
  actor: TestActor,
  projectId: string,
  payload: Record<string, unknown>,
): Promise<{ id: string; number: number; subject: string; status: string }> {
  const res = await app.inject({
    method: "POST",
    url: url(`/projects/${projectId}/rfis`),
    headers: actor.headers,
    payload: { subject: "RFI", question: "Question?", ...payload },
  });
  if (res.statusCode !== 201) throw new Error(`createRfi failed: ${res.statusCode} ${res.body}`);
  return res.json() as { id: string; number: number; subject: string; status: string };
}

/** ISO calendar date N days from now (negative = past). */
export function dayOffset(days: number, from = new Date()): string {
  return new Date(from.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

export type { TestActor };
export { registerActor };
