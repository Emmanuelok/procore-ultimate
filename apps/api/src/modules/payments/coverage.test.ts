/**
 * WP-FIN2 — the statutory-payments route the upgrade suite did not reach.
 *
 *   GET /projects/:id/payments/health-inputs   the intelligence feed (§3.5)
 *
 * The statutory dimension is the one place where the honest answer is usually
 * "nothing has been served here", and a health score that read that as
 * perfect would be worse than no score at all — so the endpoint is tested for
 * what it says when there is nothing to say, for sweeping a claim to `deemed`
 * before counting it, and for refusing another company.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { paymentClaims, projects, vendors } from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import { addDaysISO, todayISO } from "../field/dates.js";

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
let outsider: TestActor;
let projectId: string;
let emptyProjectId: string;
let vendorId: string;

const inject = (
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  url: string,
  headers: Record<string, string>,
  payload?: unknown,
) =>
  app.inject({
    method,
    url,
    headers,
    ...(payload !== undefined ? { payload } : {}),
  });

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  owner = await registerActor(app, { companyName: "FIN2 Statutory Coverage" });
  outsider = await registerActor(app);
  projectId = newId("prj");
  emptyProjectId = newId("prj");
  await app.db.insert(projects).values([
    { id: projectId, companyId: owner.companyId, name: "FIN2 statutory coverage" },
    { id: emptyProjectId, companyId: owner.companyId, name: "Nothing served" },
  ]);
  vendorId = newId("ven");
  await app.db
    .insert(vendors)
    .values({ id: vendorId, companyId: owner.companyId, name: "Tier-2 Groundworks" });
});

afterAll(async () => {
  await built.close();
});

describe("statutory payments health inputs", () => {
  it("says the statutory dimension is unrated when nothing has been served", async () => {
    const res = await inject(
      "GET",
      `/api/v1/projects/${emptyProjectId}/payments/health-inputs`,
      owner.headers,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      metrics: Record<string, number | null>;
      reasons: string[];
      asOf: string;
    };
    expect(body.metrics["paymentClaims"]).toBe(0);
    expect(body.metrics["openLiens"]).toBe(0);
    expect(body.reasons.join(" ")).toMatch(/unrated/i);
    /* the disclaimer travels with every computed statutory deadline */
    expect(body.reasons.join(" ")).toMatch(/indicative/i);
    expect(body.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("counts a live claim and the response falling due inside the next week", async () => {
    const created = await inject(
      "POST",
      `/api/v1/projects/${projectId}/payment-claims`,
      owner.headers,
      {
        regime: "uk_hgcra",
        referenceDate: todayISO(),
        claimedAmount: 120_000,
        currency: "GBP",
        description: "Interim application 7",
      },
    );
    expect(created.statusCode).toBe(201);
    const claimId = created.json().id as string;
    const served = await inject(
      "POST",
      `/api/v1/projects/${projectId}/payment-claims/${claimId}/serve`,
      owner.headers,
      { method: "email", reference: "AP-07" },
    );
    expect(served.statusCode).toBe(200);

    const res = await inject(
      "GET",
      `/api/v1/projects/${projectId}/payments/health-inputs`,
      owner.headers,
    );
    const body = res.json() as { metrics: Record<string, number> };
    expect(body.metrics["paymentClaims"]).toBe(1);
    expect(body.metrics["deemedClaims"]).toBe(0);
    /* the UK clock is well inside a week from service */
    expect(body.metrics["responsesDueWithin7"]).toBe(1);
    /* counts only — never a money total that could cross GBP and USD */
    for (const value of Object.values(body.metrics)) {
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  it("sweeps an overdue claim to deemed BEFORE counting it, so the count is not a lie", async () => {
    const [claim] = await app.db
      .select({ id: paymentClaims.id })
      .from(paymentClaims)
      .where(eq(paymentClaims.projectId, projectId));
    /* wind the response deadline into the past without touching the status */
    await app.db
      .update(paymentClaims)
      .set({ responseDeadline: addDaysISO(todayISO(), -3) })
      .where(eq(paymentClaims.id, claim!.id));

    const res = await inject(
      "GET",
      `/api/v1/projects/${projectId}/payments/health-inputs`,
      owner.headers,
    );
    const body = res.json() as { metrics: Record<string, number> };
    expect(body.metrics["deemedClaims"]).toBe(1);
    expect(body.metrics["responsesDueWithin7"]).toBe(0);
    const [after] = await app.db
      .select({ status: paymentClaims.status })
      .from(paymentClaims)
      .where(eq(paymentClaims.id, claim!.id));
    expect(after!.status).toBe("deemed");
  });

  it("does not serve another company's statutory health inputs", async () => {
    const res = await inject(
      "GET",
      `/api/v1/projects/${projectId}/payments/health-inputs`,
      outsider.headers,
    );
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});
