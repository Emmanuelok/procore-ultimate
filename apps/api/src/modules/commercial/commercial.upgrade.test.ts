/**
 * Integration tests for the commercial upgrade: sub-resource authorisation,
 * valuation sequence discipline, retention with cap and release, certificate
 * withdrawal and payment, typed sections, dayworks, remeasurement, provisional
 * sums, measurement-standard validation, CSV import/export, rate analysis,
 * fluctuations, CVR and the final account — plus cross-tenant negatives.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  boqItems,
  boqs,
  companyMemberships,
  contracts,
  projectMemberships,
  projects,
  signals,
  valuations,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { listSearchSources } from "../search/registry.js";
import type { BuiltApp } from "../../app.js";
import { newId } from "../../lib/ids.js";

let built: BuiltApp;
let owner: TestActor; // company owner — certifier / verifier
let member: TestActor; // project_admin on the project — applicant / submitter
let outsider: TestActor; // company member with NO project membership
let stranger: TestActor; // a different company entirely
let memberHeaders: Record<string, string>;
let outsiderHeaders: Record<string, string>;
let projectId: string;
let contractId: string;

function isoDaysFromToday(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const inject = (
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  headers: Record<string, string>,
  payload?: unknown,
) => built.app.inject({ method, url, headers, ...(payload !== undefined ? { payload } : {}) });

beforeAll(async () => {
  built = await buildTestApp();
  owner = await registerActor(built.app);
  member = await registerActor(built.app);
  outsider = await registerActor(built.app);
  stranger = await registerActor(built.app);
  for (const u of [member, outsider]) {
    await built.app.db.insert(companyMemberships).values({
      id: newId("cm"),
      companyId: owner.companyId,
      userId: u.userId,
      role: "member",
    });
  }
  memberHeaders = { authorization: member.headers["authorization"]!, "x-company-id": owner.companyId };
  outsiderHeaders = {
    authorization: outsider.headers["authorization"]!,
    "x-company-id": owner.companyId,
  };

  projectId = newId("prj");
  await built.app.db.insert(projects).values({
    id: projectId,
    companyId: owner.companyId,
    name: "Commercial upgrade project",
  });
  await built.app.db.insert(projectMemberships).values({
    id: newId("pm"),
    companyId: owner.companyId,
    projectId,
    userId: member.userId,
    templateKey: "project_admin",
    overrides: {},
  });

  contractId = newId("con");
  await built.app.db.insert(contracts).values({
    id: contractId,
    companyId: owner.companyId,
    projectId,
    name: "Main works",
    form: "fidic_red_2017",
    currency: "GBP",
    contractSum: 10_000_000,
    retentionPercent: 5,
    retentionCap: 500_000,
    completionDate: isoDaysFromToday(-30),
    defectsPeriodMonths: 12,
    ldRatePerDay: 1_000,
    ldCap: 100_000,
    createdBy: owner.userId,
  });
}, 180_000);

afterAll(async () => {
  await built.close();
});

/** Build a priced, issued bill with two items. */
async function makeBill(options: { currency?: string; contractId?: string | null } = {}) {
  const res = await inject("POST", `/api/v1/projects/${projectId}/boqs`, owner.headers, {
    name: `Bill ${Math.random().toString(36).slice(2, 8)}`,
    method: "nrm2",
    currency: options.currency ?? "GBP",
    contractId: options.contractId === undefined ? contractId : options.contractId,
  });
  const boqId = res.json().id as string;
  const bill = await inject("POST", `/api/v1/boqs/${boqId}/items`, owner.headers, {
    level: "bill",
    code: "1",
    description: "Substructure works",
  });
  const mk = async (code: string, description: string, qty: number, rate: number, unit = "m3") => {
    const r = await inject("POST", `/api/v1/boqs/${boqId}/items`, owner.headers, {
      level: "item",
      code,
      description,
      unit,
      parentId: bill.json().id,
      quantity: qty,
      rate,
    });
    return r.json().id as string;
  };
  const item1 = await mk("1.1", "Excavating trenches not exceeding 2m deep", 1000, 40);
  const item2 = await mk("1.2", "Concrete grade C32/40 in foundations", 500, 200);
  await inject("PATCH", `/api/v1/boqs/${boqId}`, owner.headers, { status: "issued" });
  return { boqId, item1, item2 };
}

/* ------------------------------------------------------------------ */
/* Authorisation on sub-resource routes (production blocker)           */
/* ------------------------------------------------------------------ */

describe("sub-resource authorisation", () => {
  let boqId: string;
  let itemId: string;
  let valuationId: string;
  let certId: string;
  let variationId: string;

  beforeAll(async () => {
    const bill = await makeBill();
    boqId = bill.boqId;
    itemId = bill.item1;
    const val = await inject("POST", `/api/v1/projects/${projectId}/valuations`, memberHeaders, {
      boqId,
      valuationDate: isoDaysFromToday(0),
      basis: "remeasure",
    });
    valuationId = val.json().id as string;
    await inject("PUT", `/api/v1/valuations/${valuationId}/lines`, memberHeaders, {
      lines: [{ boqItemId: itemId, qtyToDate: 100 }],
    });
    await inject("POST", `/api/v1/valuations/${valuationId}/submit`, memberHeaders);
    const cert = await inject("POST", `/api/v1/valuations/${valuationId}/certify`, owner.headers, {});
    certId = cert.json().id as string;
    const v = await inject("POST", `/api/v1/projects/${projectId}/variations`, owner.headers, {
      title: "Additional piling",
      basis: "star_rate",
      costEstimate: 25_000,
    });
    variationId = v.json().id as string;
  });

  it("refuses a company member who is not on the project on every sub-resource GET", async () => {
    const urls = [
      `/api/v1/boqs/${boqId}`,
      `/api/v1/boqs/${boqId}/summary`,
      `/api/v1/boq-items/${itemId}/takeoff`,
      `/api/v1/valuations/${valuationId}`,
      `/api/v1/certificates/${certId}`,
      `/api/v1/variations/${variationId}`,
      `/api/v1/boqs/${boqId}/measurement-check`,
      `/api/v1/boq-items/${itemId}/rate-analysis`,
    ];
    for (const url of urls) {
      const res = await inject("GET", url, outsiderHeaders);
      expect(res.statusCode, `${url} must not be readable by a non-member`).toBe(403);
    }
  });

  it("still serves the same reads to a project member", async () => {
    for (const url of [
      `/api/v1/boqs/${boqId}`,
      `/api/v1/valuations/${valuationId}`,
      `/api/v1/certificates/${certId}`,
      `/api/v1/variations/${variationId}`,
    ]) {
      const res = await inject("GET", url, memberHeaders);
      expect(res.statusCode, url).toBe(200);
    }
  });

  it("refuses another company outright", async () => {
    const res = await inject("GET", `/api/v1/boqs/${boqId}`, stranger.headers);
    expect([403, 404]).toContain(res.statusCode);
    const list = await inject(
      "GET",
      `/api/v1/projects/${projectId}/boqs`,
      stranger.headers,
    );
    expect([403, 404]).toContain(list.statusCode);
  });
});

/* ------------------------------------------------------------------ */
/* Valuation sequence, retention cap, certificate lifecycle            */
/* ------------------------------------------------------------------ */

describe("valuation sequence and retention", () => {
  let boqId: string;
  let item1: string;

  beforeAll(async () => {
    const bill = await makeBill();
    boqId = bill.boqId;
    item1 = bill.item1;
  });

  it("refuses a valuation against a draft bill", async () => {
    const draft = await inject("POST", `/api/v1/projects/${projectId}/boqs`, owner.headers, {
      name: "Draft bill",
      method: "nrm2",
      currency: "GBP",
      contractId,
    });
    const res = await inject("POST", `/api/v1/projects/${projectId}/valuations`, owner.headers, {
      boqId: draft.json().id,
      valuationDate: isoDaysFromToday(0),
      basis: "remeasure",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("issued or agreed");
  });

  it("defaults retention from the contract and applies its cap", async () => {
    const val = await inject("POST", `/api/v1/projects/${projectId}/valuations`, memberHeaders, {
      boqId,
      valuationDate: isoDaysFromToday(0),
      basis: "remeasure",
    });
    expect(val.statusCode).toBe(201);
    const body = val.json() as { id: string; retentionPercent: number; retentionCap: number };
    expect(body.retentionPercent).toBe(5); // from the contract, not the request
    expect(body.retentionCap).toBe(500_000);

    // 1000 × 40 = 40,000 + 500 × 200 = 100,000 → gross 140,000; 5% = 7,000 (uncapped)
    await inject("PUT", `/api/v1/valuations/${body.id}/lines`, memberHeaders, {
      lines: [{ boqItemId: item1, qtyToDate: 1000 }],
    });
    const afterLines = await inject("GET", `/api/v1/valuations/${body.id}`, memberHeaders);
    const v = afterLines.json() as { retentionHeld: number; netDue: number; grossTotal: number };
    expect(v.grossTotal).toBe(40_000);
    expect(v.retentionHeld).toBe(2_000);
    expect(v.netDue).toBe(38_000);
  });

  it("refuses a second open application on the same bill", async () => {
    const second = await inject("POST", `/api/v1/projects/${projectId}/valuations`, memberHeaders, {
      boqId,
      valuationDate: isoDaysFromToday(1),
      basis: "remeasure",
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().message).toContain("still draft");
  });

  it("caps retention on a very large application", async () => {
    const bill = await makeBill();
    const val = await inject("POST", `/api/v1/projects/${projectId}/valuations`, memberHeaders, {
      boqId: bill.boqId,
      valuationDate: isoDaysFromToday(0),
      basis: "percent",
    });
    const id = val.json().id as string;
    // 100% of both items = 140,000 — under the cap; push materials to exceed it
    await inject("PUT", `/api/v1/valuations/${id}/lines`, memberHeaders, {
      lines: [
        { boqItemId: bill.item1, percentToDate: 100 },
        { boqItemId: bill.item2, percentToDate: 100 },
      ],
    });
    await inject("PATCH", `/api/v1/valuations/${id}`, memberHeaders, {
      materialsOnSite: 20_000_000,
    });
    const res = await inject("GET", `/api/v1/valuations/${id}`, memberHeaders);
    const v = res.json() as { retentionHeld: number; grossTotal: number };
    expect(v.grossTotal).toBe(20_140_000);
    // 5% would be 1,007,000; the contract caps it at 500,000
    expect(v.retentionHeld).toBe(500_000);
  });

  it("never issues a negative certificate when applications are certified in order", async () => {
    const bill = await makeBill();
    const mkVal = async (date: string, percent: number) => {
      const created = await inject("POST", `/api/v1/projects/${projectId}/valuations`, memberHeaders, {
        boqId: bill.boqId,
        valuationDate: date,
        basis: "percent",
      });
      const id = created.json().id as string;
      await inject("PUT", `/api/v1/valuations/${id}/lines`, memberHeaders, {
        lines: [{ boqItemId: bill.item2, percentToDate: percent }],
      });
      await inject("POST", `/api/v1/valuations/${id}/submit`, memberHeaders);
      return id;
    };
    const v1 = await mkVal(isoDaysFromToday(-30), 20); // 20,000
    const c1 = await inject("POST", `/api/v1/valuations/${v1}/certify`, owner.headers, {});
    expect(c1.statusCode).toBe(201);
    expect(c1.json().netCertified).toBe(19_000); // 20,000 less 5% retention

    const v2 = await mkVal(isoDaysFromToday(0), 60); // 60,000 cumulative
    const c2 = await inject("POST", `/api/v1/valuations/${v2}/certify`, owner.headers, {});
    expect(c2.statusCode).toBe(201);
    const cert2 = c2.json() as { netCertified: number; previousCertified: number };
    expect(cert2.previousCertified).toBe(19_000);
    expect(cert2.netCertified).toBe(38_000); // 60,000 − 3,000 retention − 19,000
    expect(cert2.netCertified).toBeGreaterThan(0);
  });

  it("refuses to certify while an earlier application on the bill is still open", async () => {
    const bill = await makeBill();
    const mk = async (date: string, percent: number) => {
      const created = await inject("POST", `/api/v1/projects/${projectId}/valuations`, memberHeaders, {
        boqId: bill.boqId,
        valuationDate: date,
        basis: "percent",
      });
      const id = created.json().id as string;
      await inject("PUT", `/api/v1/valuations/${id}/lines`, memberHeaders, {
        lines: [{ boqItemId: bill.item2, percentToDate: percent }],
      });
      await inject("POST", `/api/v1/valuations/${id}/submit`, memberHeaders);
      return id;
    };
    await mk(isoDaysFromToday(-30), 20);
    // The create guard already refuses a second open application, so the
    // certify guard is exercised by inserting VAL-2 directly — the shape a
    // migration or an integration would produce.
    const v2 = newId("val");
    await built.app.db.insert(valuations).values({
      id: v2,
      companyId: owner.companyId,
      projectId,
      contractId,
      boqId: bill.boqId,
      number: 999,
      valuationDate: isoDaysFromToday(0),
      basis: "percent",
      status: "submitted",
      currency: "GBP",
      retentionPercent: 5,
      submittedBy: member.userId,
      createdBy: member.userId,
    });
    const res = await inject("POST", `/api/v1/valuations/${v2}/certify`, owner.headers, {});
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("must be certified first");
    // clean up so later sequence checks are not blocked
    await built.app.db.delete(valuations).where(eq(valuations.id, v2));
  });

  it("withdraws a certificate, restoring the application, and records payment", async () => {
    const bill = await makeBill();
    const created = await inject("POST", `/api/v1/projects/${projectId}/valuations`, memberHeaders, {
      boqId: bill.boqId,
      valuationDate: isoDaysFromToday(0),
      basis: "percent",
    });
    const valId = created.json().id as string;
    await inject("PUT", `/api/v1/valuations/${valId}/lines`, memberHeaders, {
      lines: [{ boqItemId: bill.item2, percentToDate: 50 }],
    });
    await inject("POST", `/api/v1/valuations/${valId}/submit`, memberHeaders);
    const cert = await inject("POST", `/api/v1/valuations/${valId}/certify`, owner.headers, {});
    const certId = cert.json().id as string;
    expect(cert.json().netCertified).toBe(47_500);

    const withdraw = await inject(
      "POST",
      `/api/v1/certificates/${certId}/withdraw`,
      owner.headers,
      { reason: "Issued against the wrong application" },
    );
    expect(withdraw.statusCode).toBe(200);
    expect(withdraw.json().status).toBe("withdrawn");
    const [val] = await built.app.db.select().from(valuations).where(eq(valuations.id, valId));
    expect(val!.status).toBe("submitted");

    const recert = await inject("POST", `/api/v1/valuations/${valId}/certify`, owner.headers, {
      certifiedWorkDone: 40_000,
      varianceReason: "Quantity not agreed on item 1.2",
    });
    expect(recert.statusCode).toBe(201);
    const newCertId = recert.json().id as string;
    // the withdrawn certificate no longer nets off the new one
    expect(recert.json().previousCertified).toBe(0);

    const paid = await inject("POST", `/api/v1/certificates/${newCertId}/paid`, owner.headers, {
      amount: 30_000,
      paidOn: isoDaysFromToday(0),
      reference: "BACS-9001",
    });
    expect(paid.statusCode).toBe(200);
    const paidBody = paid.json() as { status: string; shortPaid: number };
    expect(paidBody.status).toBe("paid");
    expect(paidBody.shortPaid).toBeGreaterThan(0);
    const [reloaded] = await built.app.db
      .select()
      .from(valuations)
      .where(eq(valuations.id, valId));
    expect(reloaded!.status).toBe("paid");
  });

  it("refuses a certifier who submitted the application", async () => {
    const bill = await makeBill();
    const created = await inject("POST", `/api/v1/projects/${projectId}/valuations`, memberHeaders, {
      boqId: bill.boqId,
      valuationDate: isoDaysFromToday(0),
      basis: "percent",
    });
    const valId = created.json().id as string;
    await inject("PUT", `/api/v1/valuations/${valId}/lines`, memberHeaders, {
      lines: [{ boqItemId: bill.item2, percentToDate: 10 }],
    });
    await inject("POST", `/api/v1/valuations/${valId}/submit`, memberHeaders);
    const res = await inject("POST", `/api/v1/valuations/${valId}/certify`, memberHeaders, {});
    expect(res.statusCode).toBe(403);
  });
});

/* ------------------------------------------------------------------ */
/* Valuation sections                                                  */
/* ------------------------------------------------------------------ */

describe("valuation sections", () => {
  let boqId: string;
  let item2: string;
  let valId: string;

  beforeAll(async () => {
    const bill = await makeBill();
    boqId = bill.boqId;
    item2 = bill.item2;
    const created = await inject("POST", `/api/v1/projects/${projectId}/valuations`, memberHeaders, {
      boqId,
      valuationDate: isoDaysFromToday(0),
      basis: "percent",
    });
    valId = created.json().id as string;
    await inject("PUT", `/api/v1/valuations/${valId}/lines`, memberHeaders, {
      lines: [{ boqItemId: item2, percentToDate: 50 }], // 50,000
    });
  });

  it("rolls typed sections into the gross and keeps contra charges out of retention", async () => {
    const variation = await inject(
      "POST",
      `/api/v1/valuations/${valId}/sections`,
      memberHeaders,
      {
        kind: "variation",
        description: "VO-001 agreed value",
        amountToDate: 20_000,
      },
    );
    expect(variation.statusCode).toBe(201);
    const contra = await inject("POST", `/api/v1/valuations/${valId}/sections`, memberHeaders, {
      kind: "contra_charge",
      description: "Attendance recharge",
      amountToDate: -5_000,
    });
    expect(contra.statusCode).toBe(201);
    expect(contra.json().retentionApplies).toBe(false);

    const res = await inject("GET", `/api/v1/valuations/${valId}`, memberHeaders);
    const v = res.json() as {
      sectionsTotal: number;
      grossTotal: number;
      retentionHeld: number;
      netDue: number;
    };
    expect(v.sectionsTotal).toBe(15_000);
    expect(v.grossTotal).toBe(65_000);
    // retention base excludes the contra charge: 5% of 70,000
    expect(v.retentionHeld).toBe(3_500);
    expect(v.netDue).toBe(61_500);
  });

  it("refuses a positive contra charge and unevidenced materials", async () => {
    const positive = await inject("POST", `/api/v1/valuations/${valId}/sections`, memberHeaders, {
      kind: "contra_charge",
      description: "Should be negative",
      amountToDate: 100,
    });
    expect(positive.statusCode).toBe(400);

    const unvested = await inject("POST", `/api/v1/valuations/${valId}/sections`, memberHeaders, {
      kind: "materials_off_site",
      description: "Fabricated steelwork in the yard",
      amountToDate: 80_000,
    });
    expect(unvested.statusCode).toBe(400);
    expect(unvested.json().message).toContain("vesting certificate");

    const vested = await inject("POST", `/api/v1/valuations/${valId}/sections`, memberHeaders, {
      kind: "materials_off_site",
      description: "Fabricated steelwork in the yard",
      amountToDate: 80_000,
      evidenceRef: "Off-site bond OSB-11 / vesting certificate VC-4",
    });
    expect(vested.statusCode).toBe(201);
  });

  it("pulls agreed variations into the application without duplicating them", async () => {
    const v = await inject("POST", `/api/v1/projects/${projectId}/variations`, owner.headers, {
      title: "Extra drainage",
      basis: "star_rate",
      costEstimate: 12_000,
      contractId,
    });
    const varId = v.json().id as string;
    await inject("POST", `/api/v1/variations/${varId}/status`, owner.headers, {
      status: "instructed",
      instructionRef: "AI-010",
      instructedAt: isoDaysFromToday(-5),
    });
    await inject("POST", `/api/v1/variations/${varId}/value`, owner.headers, {
      basis: "star_rate",
      agreedValue: 12_000,
    });
    await inject("POST", `/api/v1/variations/${varId}/status`, owner.headers, { status: "agreed" });

    const first = await inject("POST", `/api/v1/valuations/${valId}/sections/sync`, memberHeaders);
    expect(first.statusCode).toBe(200);
    expect(first.json().added).toBeGreaterThanOrEqual(1);
    const second = await inject("POST", `/api/v1/valuations/${valId}/sections/sync`, memberHeaders);
    expect(second.json().added).toBe(0);
    expect(second.json().updated).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Variations                                                          */
/* ------------------------------------------------------------------ */

describe("variation register", () => {
  it("refuses to agree a variation that has never been valued", async () => {
    const v = await inject("POST", `/api/v1/projects/${projectId}/variations`, owner.headers, {
      title: "Unvalued change",
      basis: "star_rate",
      costEstimate: 250_000,
    });
    const id = v.json().id as string;
    await inject("POST", `/api/v1/variations/${id}/status`, owner.headers, {
      status: "instructed",
      instructionRef: "AI-020",
      instructedAt: isoDaysFromToday(-2),
    });
    const valued = await inject("POST", `/api/v1/variations/${id}/status`, owner.headers, {
      status: "valued",
    });
    expect(valued.statusCode).toBe(200);
    const agreed = await inject("POST", `/api/v1/variations/${id}/status`, owner.headers, {
      status: "agreed",
    });
    expect(agreed.statusCode).toBe(400);
    expect(agreed.json().message).toContain("Value the variation first");

    await inject("POST", `/api/v1/variations/${id}/value`, owner.headers, {
      basis: "star_rate",
      agreedValue: 250_000,
    });
    const nowAgreed = await inject("POST", `/api/v1/variations/${id}/status`, owner.headers, {
      status: "agreed",
    });
    expect(nowAgreed.statusCode).toBe(200);
    expect(nowAgreed.json().agreedValue).toBe(250_000);
  });

  it("persists the build-up so star rates are queryable", async () => {
    const v = await inject("POST", `/api/v1/projects/${projectId}/variations`, owner.headers, {
      title: "Bespoke handrail",
      basis: "star_rate",
      contractId,
    });
    const id = v.json().id as string;
    await inject("POST", `/api/v1/variations/${id}/value`, owner.headers, {
      basis: "star_rate",
      buildUp: [
        { description: "Fabricate handrail", unit: "m", qty: 30, rate: 120 },
        { description: "Install", unit: "m", qty: 30, rate: 45 },
      ],
    });
    const detail = await inject("GET", `/api/v1/variations/${id}`, owner.headers);
    const body = detail.json() as { agreedValue: number; buildUp: Array<{ amount: number }> };
    expect(body.agreedValue).toBe(4_950);
    expect(body.buildUp).toHaveLength(2);

    const register = await inject(
      "GET",
      `/api/v1/projects/${projectId}/commercial/star-rates`,
      owner.headers,
    );
    expect(register.statusCode).toBe(200);
    expect((register.json().items as unknown[]).length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* BQ items, taking-off, measurement standards, import/export          */
/* ------------------------------------------------------------------ */

describe("bill discipline", () => {
  it("sorts codes naturally and assigns sortOrder on create", async () => {
    const res = await inject("POST", `/api/v1/projects/${projectId}/boqs`, owner.headers, {
      name: "Sorting bill",
      method: "nrm2",
      currency: "GBP",
      contractId,
    });
    const boqId = res.json().id as string;
    const bill = await inject("POST", `/api/v1/boqs/${boqId}/items`, owner.headers, {
      level: "bill",
      code: "1",
      description: "Works",
    });
    // created out of order and all on the same explicit sortOrder, so the
    // natural (numeric-aware) comparator is what decides the bill order
    for (const code of ["1.1", "1.10", "1.2", "1.11", "1.3"]) {
      await inject("POST", `/api/v1/boqs/${boqId}/items`, owner.headers, {
        level: "item",
        code,
        description: `Item ${code}`,
        unit: "m",
        parentId: bill.json().id,
        quantity: 1,
        rate: 1,
        sortOrder: 0,
      });
    }
    const detail = await inject("GET", `/api/v1/boqs/${boqId}`, owner.headers);
    const children = (detail.json().items as Array<{ children: Array<{ code: string }> }>)[0]!
      .children;
    expect(children.map((c) => c.code)).toEqual(["1.1", "1.2", "1.3", "1.10", "1.11"]);
  });

  it("keeps insertion order when sortOrder is auto-assigned", async () => {
    const res = await inject("POST", `/api/v1/projects/${projectId}/boqs`, owner.headers, {
      name: "Insertion order bill",
      method: "nrm2",
      currency: "GBP",
      contractId,
    });
    const boqId = res.json().id as string;
    const bill = await inject("POST", `/api/v1/boqs/${boqId}/items`, owner.headers, {
      level: "bill",
      code: "1",
      description: "Works",
    });
    for (const code of ["1.3", "1.1", "1.2"]) {
      await inject("POST", `/api/v1/boqs/${boqId}/items`, owner.headers, {
        level: "item",
        code,
        description: `Item ${code}`,
        unit: "m",
        parentId: bill.json().id,
        quantity: 1,
        rate: 1,
      });
    }
    const detail = await inject("GET", `/api/v1/boqs/${boqId}`, owner.headers);
    const children = (detail.json().items as Array<{ children: Array<{ code: string }> }>)[0]!
      .children;
    expect(children.map((c) => c.code)).toEqual(["1.3", "1.1", "1.2"]);
  });

  it("refuses a negative manual take-off quantity and nets deductions", async () => {
    const bill = await makeBill();
    const negative = await inject(
      "POST",
      `/api/v1/boq-items/${bill.item1}/takeoff`,
      owner.headers,
      { description: "Bad line", quantity: -500 },
    );
    expect(negative.statusCode).toBe(400);

    await inject("POST", `/api/v1/boq-items/${bill.item1}/takeoff`, owner.headers, {
      description: "Main trench",
      length: 20,
      width: 2,
      depth: 1.5,
    });
    await inject("POST", `/api/v1/boq-items/${bill.item1}/takeoff`, owner.headers, {
      description: "Deduct manhole",
      length: 2,
      width: 2,
      depth: 1.5,
      deduct: true,
    });
    const list = await inject("GET", `/api/v1/boq-items/${bill.item1}/takeoff`, owner.headers);
    const body = list.json() as { total: number; added: number; deducted: number };
    expect(body.added).toBe(60); // 20 × 2 × 1.5
    expect(body.deducted).toBe(6); // 2 × 2 × 1.5
    expect(body.total).toBe(54);

    const applied = await inject(
      "POST",
      `/api/v1/boq-items/${bill.item1}/takeoff/apply`,
      owner.headers,
    );
    expect(applied.statusCode).toBe(200);
    expect(applied.json().quantity).toBe(54);
  });

  it("refuses to move a rate away from its build-up without restating it", async () => {
    const res = await inject("POST", `/api/v1/projects/${projectId}/boqs`, owner.headers, {
      name: "Build-up bill",
      method: "nrm2",
      currency: "GBP",
      contractId,
    });
    const boqId = res.json().id as string;
    const bill = await inject("POST", `/api/v1/boqs/${boqId}/items`, owner.headers, {
      level: "bill",
      code: "1",
      description: "Works",
    });
    const item = await inject("POST", `/api/v1/boqs/${boqId}/items`, owner.headers, {
      level: "item",
      code: "1.1",
      description: "Blockwork 140mm in cement mortar",
      unit: "m2",
      parentId: bill.json().id,
      quantity: 100,
      rateBuildUp: [
        { kind: "labour", description: "Bricklayer gang", qty: 1, rate: 60 },
        { kind: "material", description: "Blocks and mortar", qty: 1, rate: 30 },
        { kind: "profit", description: "Profit", qty: 1, rate: 10 },
      ],
    });
    const itemId = item.json().id as string;
    expect(item.json().rate).toBe(100);

    const bare = await inject("PATCH", `/api/v1/boq-items/${itemId}`, owner.headers, { rate: 999 });
    expect(bare.statusCode).toBe(400);
    expect(bare.json().message).toContain("build-up");

    const cleared = await inject("PATCH", `/api/v1/boq-items/${itemId}`, owner.headers, {
      rate: 999,
      clearRateBuildUp: true,
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().rateBuildUp).toBeNull();
    expect(cleared.json().rate).toBe(999);
  });

  it("refuses to delete a BQ item that a valuation line references", async () => {
    const bill = await makeBill();
    const created = await inject("POST", `/api/v1/projects/${projectId}/valuations`, memberHeaders, {
      boqId: bill.boqId,
      valuationDate: isoDaysFromToday(0),
      basis: "percent",
    });
    expect(created.statusCode).toBe(201);
    // the bill is issued, so deletion is already refused; make it draft-like by
    // proving the guard fires on the reference rather than only on the status
    await built.app.db
      .update(boqs)
      .set({ status: "draft" })
      .where(eq(boqs.id, bill.boqId));
    const res = await inject("DELETE", `/api/v1/boq-items/${bill.item1}`, owner.headers);
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("valuation line");
    await built.app.db
      .update(boqs)
      .set({ status: "issued" })
      .where(eq(boqs.id, bill.boqId));
  });

  it("validates the bill against its measurement standard", async () => {
    const bill = await makeBill();
    await inject("POST", `/api/v1/boqs/${bill.boqId}/items`, owner.headers, {
      level: "item",
      code: "1.9",
      description: "TBC",
      unit: "cubits",
      parentId: (await inject("GET", `/api/v1/boqs/${bill.boqId}`, owner.headers)).json().items[0].id,
      quantity: 5,
      rate: 5,
    });
    const res = await inject("GET", `/api/v1/boqs/${bill.boqId}/measurement-check`, owner.headers);
    expect(res.statusCode).toBe(200);
    const report = res.json() as {
      standardName: string;
      counts: { error: number; warning: number };
      findings: Array<{ ruleId: string }>;
      complianceScore: number;
    };
    expect(report.standardName).toContain("NRM2");
    expect(report.counts.error).toBeGreaterThan(0);
    expect(report.findings.some((f) => f.ruleId === "unit.not_recognised")).toBe(true);
    expect(report.findings.some((f) => f.ruleId === "description.vague")).toBe(true);
    expect(report.complianceScore).toBeLessThan(100);
  });

  it("round-trips a bill through CSV export and import", async () => {
    const bill = await makeBill();
    const exported = await inject(
      "GET",
      `/api/v1/boqs/${bill.boqId}/export?format=csv`,
      owner.headers,
    );
    expect(exported.statusCode).toBe(200);
    expect(exported.headers["content-type"]).toContain("text/csv");
    const csv = exported.body;
    expect(csv.split("\n")[0]).toContain("code,description,unit,quantity,rate");

    const target = await inject("POST", `/api/v1/projects/${projectId}/boqs`, owner.headers, {
      name: "Imported bill",
      method: "nrm2",
      currency: "GBP",
      contractId,
    });
    const targetId = target.json().id as string;
    const imported = await inject("POST", `/api/v1/boqs/${targetId}/import`, owner.headers, {
      content: csv,
    });
    expect(imported.statusCode).toBe(201);
    expect(imported.json().imported).toBeGreaterThanOrEqual(3);

    const detail = await inject("GET", `/api/v1/boqs/${targetId}`, owner.headers);
    expect(detail.json().totalAmount).toBe(140_000);
  });

  it("rejects an import with no usable columns", async () => {
    const target = await inject("POST", `/api/v1/projects/${projectId}/boqs`, owner.headers, {
      name: "Bad import",
      method: "nrm2",
      currency: "GBP",
    });
    const res = await inject(
      "POST",
      `/api/v1/boqs/${target.json().id}/import`,
      owner.headers,
      { content: "foo,bar\n1,2\n" },
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("code");
  });

  it("refuses a BoQ whose currency disagrees with its contract", async () => {
    const res = await inject("POST", `/api/v1/projects/${projectId}/boqs`, owner.headers, {
      name: "Wrong currency",
      method: "nrm2",
      currency: "AED",
      contractId,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("contract currency");
  });
});

/* ------------------------------------------------------------------ */
/* Remeasurement, provisional sums, dayworks                           */
/* ------------------------------------------------------------------ */

describe("remeasurement", () => {
  it("needs a second actor to agree, and applies the quantity to the bill", async () => {
    const bill = await makeBill();
    const proposed = await inject(
      "POST",
      `/api/v1/projects/${projectId}/remeasurements`,
      memberHeaders,
      {
        boqItemId: bill.item1,
        remeasuredQuantity: 1200,
        method: "site_measure",
        measuredAt: isoDaysFromToday(-1),
        note: "Trench extended to grid line F",
      },
    );
    expect(proposed.statusCode).toBe(201);
    const id = proposed.json().id as string;
    expect(proposed.json().originalQuantity).toBe(1000);

    const self = await inject(`POST`, `/api/v1/remeasurements/${id}/agree`, memberHeaders);
    expect(self.statusCode).toBe(403);

    const agreed = await inject("POST", `/api/v1/remeasurements/${id}/agree`, owner.headers);
    expect(agreed.statusCode).toBe(200);
    expect(agreed.json().status).toBe("applied");
    const [item] = await built.app.db
      .select()
      .from(boqItems)
      .where(eq(boqItems.id, bill.item1));
    expect(item!.quantity).toBe(1200);
    expect(item!.amount).toBe(48_000);
  });

  it("lists the movement in quantity and value", async () => {
    const res = await inject(
      "GET",
      `/api/v1/projects/${projectId}/remeasurements`,
      owner.headers,
    );
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<{ quantityMovement: number; valueMovement: number }>;
    expect(items[0]!.quantityMovement).toBe(200);
    expect(items[0]!.valueMovement).toBe(8_000);
  });
});

describe("provisional sums", () => {
  it("tracks expenditure against the allowance and signals an overspend once", async () => {
    const bill = await makeBill();
    const ps = await inject(
      "POST",
      `/api/v1/projects/${projectId}/provisional-sums`,
      owner.headers,
      {
        boqItemId: bill.item2,
        kind: "defined",
        title: "Provisional sum for external works",
        allowance: 50_000,
      },
    );
    expect(ps.statusCode).toBe(201);
    const psId = ps.json().id as string;

    const first = await inject(
      "POST",
      `/api/v1/provisional-sums/${psId}/expenditures`,
      owner.headers,
      { description: "Landscaping subcontract", amount: 40_000, spentOn: isoDaysFromToday(-3) },
    );
    expect(first.statusCode).toBe(201);
    expect(first.json().signalRaised).toBe(false);

    const second = await inject(
      "POST",
      `/api/v1/provisional-sums/${psId}/expenditures`,
      owner.headers,
      { description: "Additional planting", amount: 20_000, spentOn: isoDaysFromToday(-1) },
    );
    expect(second.json().expendedTotal).toBe(60_000);
    expect(second.json().signalRaised).toBe(true);

    const third = await inject(
      "POST",
      `/api/v1/provisional-sums/${psId}/expenditures`,
      owner.headers,
      { description: "Irrigation", amount: 1_000, spentOn: isoDaysFromToday(0) },
    );
    expect(third.json().signalRaised).toBe(false); // raised once per sum

    const raised = await built.app.db
      .select()
      .from(signals)
      .where(
        and(
          eq(signals.companyId, owner.companyId),
          eq(signals.detector, "provisional_sum_overspend"),
        ),
      );
    expect(raised).toHaveLength(1);
  });
});

describe("dayworks", () => {
  it("prices percentage additions per resource class and needs an independent verifier", async () => {
    const sheet = await inject(
      "POST",
      `/api/v1/projects/${projectId}/daywork-sheets`,
      memberHeaders,
      {
        workDate: isoDaysFromToday(-2),
        description: "Breaking out unrecorded obstruction",
        contractId,
        percentAdditions: { labour: 80, material: 15, plant: 10 },
      },
    );
    expect(sheet.statusCode).toBe(201);
    const sheetId = sheet.json().id as string;

    await inject("POST", `/api/v1/daywork-sheets/${sheetId}/items`, memberHeaders, {
      kind: "labour",
      description: "Ganger and two operatives",
      unit: "hr",
      qty: 24,
      rate: 25,
    });
    const withPlant = await inject(
      "POST",
      `/api/v1/daywork-sheets/${sheetId}/items`,
      memberHeaders,
      { kind: "plant", description: "8t excavator", unit: "hr", qty: 8, rate: 50 },
    );
    const body = withPlant.json() as {
      netTotal: number;
      additionTotal: number;
      grossTotal: number;
    };
    expect(body.netTotal).toBe(1_000); // 600 labour + 400 plant
    expect(body.additionTotal).toBe(520); // 80% of 600 + 10% of 400
    expect(body.grossTotal).toBe(1_520);

    const submitted = await inject("POST", `/api/v1/daywork-sheets/${sheetId}/submit`, memberHeaders);
    expect(submitted.statusCode).toBe(200);

    const selfVerify = await inject(
      "POST",
      `/api/v1/daywork-sheets/${sheetId}/verify`,
      memberHeaders,
    );
    expect(selfVerify.statusCode).toBe(403);

    const verified = await inject("POST", `/api/v1/daywork-sheets/${sheetId}/verify`, owner.headers);
    expect(verified.statusCode).toBe(200);
    expect(verified.json().status).toBe("verified");
  });

  it("refuses to submit an empty sheet", async () => {
    const sheet = await inject(
      "POST",
      `/api/v1/projects/${projectId}/daywork-sheets`,
      owner.headers,
      { workDate: isoDaysFromToday(0), description: "Nothing recorded" },
    );
    const res = await inject(
      "POST",
      `/api/v1/daywork-sheets/${sheet.json().id}/submit`,
      owner.headers,
    );
    expect(res.statusCode).toBe(400);
  });
});

/* ------------------------------------------------------------------ */
/* Rate analysis, fluctuations                                         */
/* ------------------------------------------------------------------ */

describe("rate analysis and fluctuations", () => {
  it("analyses a build-up and reports no benchmark when nothing is comparable", async () => {
    const res = await inject("POST", `/api/v1/projects/${projectId}/boqs`, owner.headers, {
      name: "Rate analysis bill",
      method: "nrm2",
      currency: "GBP",
      contractId,
    });
    const boqId = res.json().id as string;
    const bill = await inject("POST", `/api/v1/boqs/${boqId}/items`, owner.headers, {
      level: "bill",
      code: "1",
      description: "Works",
    });
    const item = await inject("POST", `/api/v1/boqs/${boqId}/items`, owner.headers, {
      level: "item",
      code: "1.1",
      description: "Unobtainium cladding panel, bespoke",
      unit: "zz",
      parentId: bill.json().id,
      quantity: 5,
      rateBuildUp: [{ kind: "material", description: "Panel", qty: 1, rate: 500 }],
    });
    const analysis = await inject(
      "GET",
      `/api/v1/boq-items/${item.json().id}/rate-analysis`,
      owner.headers,
    );
    expect(analysis.statusCode).toBe(200);
    const body = analysis.json() as {
      buildUp: { total: number; observations: string[] };
      benchmark: { verdict: string; basis: string };
    };
    expect(body.buildUp.total).toBe(500);
    expect(body.buildUp.observations.join(" ")).toContain("No profit component");
    expect(body.benchmark.verdict).toBe("no_benchmark");
  });

  it("computes an indexed price adjustment and refuses to persist an incomplete one", async () => {
    const series = await inject("POST", `/api/v1/commercial/index-series`, owner.headers, {
      code: "LAB",
      name: "Labour cost index",
      values: [
        { period: "2025-01", value: 100 },
        { period: "2026-01", value: 112 },
      ],
    });
    expect(series.statusCode).toBe(201);

    const bad = await inject(
      "POST",
      `/api/v1/projects/${projectId}/commercial/fluctuations`,
      owner.headers,
      {
        formula: "fidic_13_8",
        basePeriod: "2025-01",
        currentPeriod: "2026-01",
        nonAdjustable: 0.5,
        components: [{ seriesCode: "LAB", weighting: 0.4 }],
        workDoneAmount: 1_000_000,
        persist: true,
      },
    );
    expect(bad.statusCode).toBe(400);

    const good = await inject(
      "POST",
      `/api/v1/projects/${projectId}/commercial/fluctuations`,
      owner.headers,
      {
        formula: "fidic_13_8",
        basePeriod: "2025-01",
        currentPeriod: "2026-01",
        nonAdjustable: 0.4,
        components: [{ seriesCode: "LAB", weighting: 0.6 }],
        workDoneAmount: 1_000_000,
        contractId,
        persist: true,
      },
    );
    expect(good.statusCode).toBe(201);
    const body = good.json() as { factor: number; adjustment: number; calculationId: string };
    expect(body.factor).toBeCloseTo(1.072, 3);
    expect(body.adjustment).toBe(72_000);
    expect(body.calculationId).toBeTruthy();

    const list = await inject(
      "GET",
      `/api/v1/projects/${projectId}/commercial/fluctuations`,
      owner.headers,
    );
    expect((list.json().items as unknown[]).length).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* CVR and the final account                                           */
/* ------------------------------------------------------------------ */

describe("CVR and final account", () => {
  it("returns a null margin with a reason when there is no cost feed", async () => {
    const res = await inject(
      "GET",
      `/api/v1/projects/${projectId}/commercial/cvr?currency=GBP`,
      owner.headers,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      valueToDate: number | null;
      certifiedToDate: number;
      costToDate: number | null;
      margin: number | null;
      gaps: string[];
      overUnderCertification: number | null;
    };
    expect(body.valueToDate).not.toBeNull();
    expect(body.costToDate).toBeNull();
    expect(body.margin).toBeNull();
    expect(body.gaps.join(" ")).toContain("timecards");
    expect(body.overUnderCertification).not.toBeNull();
  });

  it("saves a CVR period when asked", async () => {
    const res = await inject(
      "GET",
      `/api/v1/projects/${projectId}/commercial/cvr?currency=GBP&save=true`,
      owner.headers,
    );
    expect(res.json().cvrPeriodId).toBeTruthy();
    const history = await inject(
      "GET",
      `/api/v1/projects/${projectId}/commercial/cvr-history`,
      owner.headers,
    );
    expect(history.json().total).toBe(1);
  });

  it("reports the cash-flow curve as unallocated until BQ money is linked to tasks", async () => {
    const res = await inject(
      "GET",
      `/api/v1/projects/${projectId}/commercial/cash-flow?currency=GBP`,
      owner.headers,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      unallocated: number;
      totalAllocated: number;
      reasons: string[];
      points: Array<{ plannedCumulative: number }>;
    };
    expect(body.unallocated).toBeGreaterThan(0);
    expect(body.totalAllocated).toBe(0);
    expect(body.reasons.join(" ")).toContain("not linked to any programme task");
    // nothing is planned because no BQ money is linked to the programme; any
    // points present carry certified actuals only
    expect(body.points.every((p) => p.plannedCumulative === 0)).toBe(true);
  });

  it("builds a traceable final account and needs two signatures from two people", async () => {
    const created = await inject(
      "POST",
      `/api/v1/projects/${projectId}/final-accounts`,
      owner.headers,
      { contractId },
    );
    expect(created.statusCode).toBe(201);
    const accountId = created.json().id as string;

    const issuedTooEarly = await inject(
      "POST",
      `/api/v1/final-accounts/${accountId}/issue`,
      owner.headers,
    );
    expect(issuedTooEarly.statusCode).toBe(400);

    const computed = await inject(
      "POST",
      `/api/v1/final-accounts/${accountId}/compute`,
      owner.headers,
    );
    expect(computed.statusCode).toBe(200);
    const account = computed.json() as {
      contractSum: number;
      finalContractSum: number;
      certifiedToDate: number;
      balanceDue: number;
      gaps: string[];
      lines: Array<{ category: string; amount: number; sourceType: string | null }>;
    };
    expect(account.contractSum).toBe(10_000_000);
    // agreed variations and LDs are in; open ones are declared as gaps
    expect(account.lines.some((l) => l.category === "variation")).toBe(true);
    expect(account.lines.some((l) => l.category === "liquidated_damages")).toBe(true);
    expect(account.lines.every((l) => l.sourceType !== null)).toBe(true);
    expect(account.gaps.length).toBeGreaterThan(0);
    expect(account.finalContractSum).not.toBe(account.contractSum);

    const manual = await inject("POST", `/api/v1/final-accounts/${accountId}/lines`, owner.headers, {
      category: "claim",
      description: "Agreed loss and expense",
      amount: 125_000,
      note: "Settled at mediation",
    });
    expect(manual.statusCode).toBe(201);

    const issued = await inject("POST", `/api/v1/final-accounts/${accountId}/issue`, owner.headers);
    expect(issued.statusCode).toBe(200);
    expect(issued.json().status).toBe("issued");

    const sign1 = await inject("POST", `/api/v1/final-accounts/${accountId}/sign`, owner.headers, {
      side: "employer",
    });
    expect(sign1.statusCode).toBe(200);
    expect(sign1.json().status).toBe("issued");

    const sameUser = await inject(
      "POST",
      `/api/v1/final-accounts/${accountId}/sign`,
      owner.headers,
      { side: "contractor" },
    );
    expect(sameUser.statusCode).toBe(403);

    const sign2 = await inject("POST", `/api/v1/final-accounts/${accountId}/sign`, memberHeaders, {
      side: "contractor",
    });
    expect(sign2.statusCode).toBe(200);
    expect(sign2.json().status).toBe("agreed");
  });
});

/* ------------------------------------------------------------------ */
/* Health inputs + scheduled sweeps                                    */
/* ------------------------------------------------------------------ */

describe("health inputs and sweeps", () => {
  it("exposes commercial health inputs with honest nulls", async () => {
    const res = await inject(
      "GET",
      `/api/v1/projects/${projectId}/commercial/health-inputs`,
      owner.headers,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json() as { metrics: Record<string, number | null>; reasons: string[] };
    expect(body.metrics["boqs"]).toBeGreaterThan(0);
    expect(body.metrics["variationsOpen"]).toBeGreaterThanOrEqual(0);
    expect(body.metrics["provisionalSumsOverspent"]).toBe(1);
    expect(Object.keys(body.metrics)).toContain("variationExposurePercent");
  });

  it("registers its sweeps with the platform scheduler and flags overdue payments", async () => {
    const names = built.app.scheduler.list().map((j) => j.name);
    expect(names).toContain("commercial.payment-due");
    expect(names).toContain("commercial.retention-due");

    // a certificate with a due date in the past
    const bill = await makeBill();
    const created = await inject("POST", `/api/v1/projects/${projectId}/valuations`, memberHeaders, {
      boqId: bill.boqId,
      valuationDate: isoDaysFromToday(-90),
      basis: "percent",
    });
    const valId = created.json().id as string;
    await inject("PUT", `/api/v1/valuations/${valId}/lines`, memberHeaders, {
      lines: [{ boqItemId: bill.item2, percentToDate: 10 }],
    });
    const submitted = await inject("POST", `/api/v1/valuations/${valId}/submit`, memberHeaders);
    // FIDIC 14.7: 56 days from the application date, which is already past
    expect(submitted.json().dueDate).toBeTruthy();
    expect(submitted.json().dueDateBasis).toContain("FIDIC");
    const cert = await inject("POST", `/api/v1/valuations/${valId}/certify`, owner.headers, {});
    expect(cert.json().dueDate).toBeTruthy();

    await built.app.scheduler.runNow("commercial.payment-due");
    const raised = await built.app.db
      .select()
      .from(signals)
      .where(
        and(eq(signals.companyId, owner.companyId), eq(signals.detector, "payment_overdue")),
      );
    expect(raised.length).toBe(1);

    // idempotent
    await built.app.scheduler.runNow("commercial.payment-due");
    const again = await built.app.db
      .select()
      .from(signals)
      .where(
        and(eq(signals.companyId, owner.companyId), eq(signals.detector, "payment_overdue")),
      );
    expect(again.length).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* Search coverage (cross-package contract §3.3)                       */
/* ------------------------------------------------------------------ */

describe("search registration", () => {
  it("registers the variation register and the bills as searchable types", () => {
    const types = listSearchSources().map((s) => s.type);
    expect(types).toContain("variation");
    expect(types).toContain("boq");
    const variationSource = listSearchSources().find((s) => s.type === "variation")!;
    // A subcontractor-template user without the commercial tool must not find
    // variations in the palette, so the source declares the tool it needs.
    expect(variationSource.tool).toBe("commercial");
    expect(variationSource.scope).toBe("project");
    expect(
      variationSource.href({
        id: "var_1",
        projectId: "prj_1",
        title: "Extra piling",
        subtitle: null,
        reference: null,
        status: "agreed",
        updatedAt: null,
      }),
    ).toBe("/projects/prj_1/commercial?tab=variations");
  });
});
