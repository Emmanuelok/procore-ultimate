import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { companyMemberships, projects, vendors } from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";

/**
 * THE SEAL BINDS THE COMPANY-LEVEL ANALYTICS TOO.
 *
 * `redactSubmission` withholds a sealed bid's amount on every submission
 * read path. The company-level registers — one vendor's whole bid history
 * (#179) and the market-position report (#1050) — are built from the same
 * `bid_submissions` rows and reached the same figure by a different door:
 * `bid-history` returned the bidder's own `amount` and its deviation from
 * the pre-tender estimate for a tender that was still sealed and unopened.
 *
 * A control implemented in nine places is a control missing from the tenth.
 */
let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
let approver: TestActor;
let projectA: string;
let alpha: string;

const HOUR = 3_600_000;
const isoIn = (ms: number) => new Date(Date.now() + ms).toISOString();
const post = (url: string, payload?: unknown, headers = owner.headers) =>
  app.inject({ method: "POST", url: `/api/v1${url}`, headers, payload: payload ?? {} });
const get = (url: string, headers = owner.headers) =>
  app.inject({ method: "GET", url: `/api/v1${url}`, headers });

const AMOUNT = 168_400;

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  owner = await registerActor(app);
  const second = await registerActor(app);
  await app.db.insert(companyMemberships).values({
    id: newId("cm"),
    companyId: owner.companyId,
    userId: second.userId,
    role: "admin",
  });
  approver = {
    ...second,
    companyId: owner.companyId,
    headers: {
      authorization: second.headers["authorization"]!,
      "x-company-id": owner.companyId,
    },
  };
  projectA = newId("prj");
  await app.db
    .insert(projects)
    .values({ id: projectA, companyId: owner.companyId, name: "Sealed analytics" });
  alpha = newId("ven");
  await app.db
    .insert(vendors)
    .values([{ id: alpha, companyId: owner.companyId, name: "Alpha Ltd" }]);
});

afterAll(async () => {
  await built.close();
});

describe("company analytics and the seal", () => {
  it("withholds a sealed, unopened bid from the vendor history and the market report", async () => {
    const created = await post(`/projects/${projectA}/bid-packages`, {
      title: "Sealed tender",
      currency: "GBP",
      engineersEstimate: 200_000,
      tradeCode: "GW",
      isSealed: true,
      // sealedUntil in the past would let the seal lift; the deadline is the
      // moment it may lift and it has not arrived.
      bidDueAt: isoIn(48 * HOUR),
    });
    expect(created.statusCode).toBe(201);
    const pkg = created.json();
    expect(
      (await post(`/projects/${projectA}/bid-packages/${pkg.id}/approve`, {}, approver.headers))
        .statusCode,
    ).toBe(200);
    expect((await post(`/projects/${projectA}/bid-packages/${pkg.id}/issue`)).statusCode).toBe(200);
    expect(
      (
        await post(`/projects/${projectA}/bid-packages/${pkg.id}/invitations`, {
          vendorId: alpha,
        })
      ).statusCode,
    ).toBe(201);
    const sub = await post(`/projects/${projectA}/bid-packages/${pkg.id}/submissions`, {
      vendorId: alpha,
      baseBidAmount: AMOUNT,
      currency: "GBP",
    });
    expect(sub.statusCode).toBe(201);

    // The submission read path already withholds it.
    const detail = await get(`/bid-submissions/${sub.json().id}`);
    expect(detail.json().seal.amountsWithheld).toBe(true);
    expect(detail.body).not.toContain(String(AMOUNT));

    // …and so must the two company-level registers built from the same rows.
    const history = await get(`/companies/current/vendors/${alpha}/bid-history`);
    expect(history.statusCode).toBe(200);
    expect(history.body).not.toContain(String(AMOUNT));
    const row = history.json().rows[0];
    // The FACT of the bid is not secret — only what it said.
    expect(row.submitted).toBe(true);
    expect(row.sealed).toBe(true);
    expect(row.amount).toBeNull();
    expect(row.deviationFromEstimatePercent).toBeNull();
    expect(row.deviationFromMedianPercent).toBeNull();

    const pricing = await get(`/companies/current/bid-pricing`);
    expect(pricing.statusCode).toBe(200);
    expect(pricing.body).not.toContain(String(AMOUNT));
    expect(pricing.json().observations).toBe(0);
  });

  it("shows the amount once the bids have been lawfully opened", async () => {
    const created = await post(`/projects/${projectA}/bid-packages`, {
      title: "Opened tender",
      currency: "GBP",
      engineersEstimate: 200_000,
      tradeCode: "GW",
      isSealed: false,
      bidDueAt: isoIn(48 * HOUR),
    });
    expect(created.statusCode).toBe(201);
    const pkg = created.json();
    expect(
      (await post(`/projects/${projectA}/bid-packages/${pkg.id}/approve`, {}, approver.headers))
        .statusCode,
    ).toBe(200);
    expect((await post(`/projects/${projectA}/bid-packages/${pkg.id}/issue`)).statusCode).toBe(200);
    expect(
      (
        await post(`/projects/${projectA}/bid-packages/${pkg.id}/invitations`, {
          vendorId: alpha,
        })
      ).statusCode,
    ).toBe(201);
    const sub = await post(`/projects/${projectA}/bid-packages/${pkg.id}/submissions`, {
      vendorId: alpha,
      baseBidAmount: 190_000,
      currency: "GBP",
    });
    expect(sub.statusCode).toBe(201);

    const history = await get(`/companies/current/vendors/${alpha}/bid-history`);
    const row = history.json().rows.find(
      (r: { packageId: string }) => r.packageId === pkg.id,
    );
    expect(row.sealed).toBe(false);
    expect(row.amount).toBe(190_000);
    expect(row.deviationFromEstimatePercent).toBe(-5);
  });
});
