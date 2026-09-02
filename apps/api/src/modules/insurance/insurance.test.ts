import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  bonds,
  companyMemberships,
  insuranceCertificates,
  insuranceClaims,
  insurancePolicies,
  obligations,
  projectMemberships,
  projects,
  signals,
  vendors,
  workers,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import { addDaysISO, todayISO } from "../field/dates.js";

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
/** second actor in the same company — the independent verifier (ADR 0004) */
let verifier: TestActor;
/** read-only project member — permission enforcement counterparty */
let viewer: TestActor;
let viewerHeaders: Record<string, string>;
/** different company entirely — tenant isolation counterparty */
let stranger: TestActor;

let mainProject: string;
let sweepProject: string;
let gapProject: string;
let bondProject: string;
let claimProject: string;
let permProject: string;
let vendorId: string;
let otherVendorId: string;

const today = () => todayISO();
const daysFromToday = (n: number) => addDaysISO(todayISO(), n);

async function makeProject(name: string, stage = "course_of_construction"): Promise<string> {
  const id = newId("prj");
  await app.db.insert(projects).values({ id, companyId: owner.companyId, name, stage });
  return id;
}

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  owner = await registerActor(app);

  verifier = await registerActor(app);
  await app.db.insert(companyMemberships).values({
    id: newId("cm"),
    companyId: owner.companyId,
    userId: verifier.userId,
    role: "admin",
  });
  verifier = {
    ...verifier,
    companyId: owner.companyId,
    headers: {
      authorization: verifier.headers["authorization"]!,
      "x-company-id": owner.companyId,
    },
  };

  viewer = await registerActor(app);
  await app.db.insert(companyMemberships).values({
    id: newId("cm"),
    companyId: owner.companyId,
    userId: viewer.userId,
    role: "member",
  });
  viewerHeaders = {
    authorization: viewer.headers["authorization"]!,
    "x-company-id": owner.companyId,
  };

  stranger = await registerActor(app);

  mainProject = await makeProject("Insurance — programme");
  sweepProject = await makeProject("Insurance — expiry sweep");
  gapProject = await makeProject("Insurance — cover gaps");
  bondProject = await makeProject("Insurance — bonds");
  claimProject = await makeProject("Insurance — claims");
  permProject = await makeProject("Insurance — permissions");

  await app.db.insert(projectMemberships).values({
    id: newId("pm"),
    companyId: owner.companyId,
    projectId: permProject,
    userId: viewer.userId,
    templateKey: "read_only",
  });

  vendorId = newId("ven");
  otherVendorId = newId("ven");
  await app.db.insert(vendors).values([
    { id: vendorId, companyId: owner.companyId, name: "Groundworks Ltd" },
    { id: otherVendorId, companyId: owner.companyId, name: "Steelwork Ltd" },
  ]);
});

afterAll(async () => {
  await built.close();
});

/* ------------------------------------------------------------------ */
/* Request helpers                                                     */
/* ------------------------------------------------------------------ */

function post(url: string, payload: unknown, headers = owner.headers) {
  return app.inject({ method: "POST", url: `/api/v1${url}`, headers, payload });
}
function get(url: string, headers = owner.headers) {
  return app.inject({ method: "GET", url: `/api/v1${url}`, headers });
}
function patch(url: string, payload: unknown, headers = owner.headers) {
  return app.inject({ method: "PATCH", url: `/api/v1${url}`, headers, payload });
}
function del(url: string, headers = owner.headers) {
  return app.inject({ method: "DELETE", url: `/api/v1${url}`, headers });
}

function policyPayload(over: Record<string, unknown> = {}) {
  return {
    policyType: "contractors_all_risks",
    insurer: "Acme Re",
    policyNumber: "CAR/2026/0001",
    limitOfIndemnity: 10_000_000,
    limitBasis: "per_occurrence",
    currency: "GBP",
    periodStart: daysFromToday(-30),
    periodEnd: daysFromToday(300),
    notificationDays: 14,
    ...over,
  };
}

/** Create + activate a policy on a project, returning its id. */
async function activePolicy(projectId: string, over: Record<string, unknown> = {}) {
  const res = await post(`/projects/${projectId}/insurance/policies`, policyPayload(over));
  expect(res.statusCode).toBe(201);
  const id = res.json().id as string;
  const activated = await post(
    `/projects/${projectId}/insurance/policies/${id}/status`,
    { status: "active" },
  );
  expect(activated.statusCode).toBe(200);
  return id;
}

async function signalsFor(detector: string, key?: string) {
  const rows = await app.db
    .select()
    .from(signals)
    .where(and(eq(signals.companyId, owner.companyId), eq(signals.detector, detector)));
  if (!key) return rows;
  return rows.filter((r) => (r.evidenceRefs as { key?: string } | null)?.key === key);
}

/* ================================================================== */
/* Policies                                                            */
/* ================================================================== */

describe("policy register (#771-776)", () => {
  it("auto-numbers a new policy and starts it in draft", async () => {
    const res = await post(`/projects/${mainProject}/insurance/policies`, policyPayload());
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.number).toBe("POL-0001");
    expect(body.status).toBe("draft");
    expect(body.projectId).toBe(mainProject);
    expect(body.derivedStatus).toBe("draft");
    expect(body.daysToExpiry).toBeGreaterThan(0);

    const second = await post(`/projects/${mainProject}/insurance/policies`, policyPayload());
    expect(second.json().number).toBe("POL-0002");
  });

  it("refuses an inverted policy period", async () => {
    const res = await post(
      `/projects/${mainProject}/insurance/policies`,
      policyPayload({ periodStart: daysFromToday(10), periodEnd: daysFromToday(5) }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/inverted/i);
  });

  it("activates a policy with a live period and refuses one whose period has run out", async () => {
    const live = await post(`/projects/${mainProject}/insurance/policies`, policyPayload());
    const liveId = live.json().id as string;
    const ok = await post(`/projects/${mainProject}/insurance/policies/${liveId}/status`, {
      status: "active",
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe("active");
    expect(ok.json().inForce).toBe(true);

    // a policy whose period already ended cannot be brought on risk
    const staleId = newId("pol");
    await app.db.insert(insurancePolicies).values({
      id: staleId,
      companyId: owner.companyId,
      projectId: mainProject,
      number: "POL-STALE",
      policyType: "third_party_liability",
      insurer: "Acme Re",
      policyNumber: "TPL/OLD",
      periodStart: daysFromToday(-400),
      periodEnd: daysFromToday(-40),
      status: "draft",
      createdBy: owner.userId,
    });
    const refused = await post(
      `/projects/${mainProject}/insurance/policies/${staleId}/status`,
      { status: "active" },
    );
    expect(refused.statusCode).toBe(400);
    expect(refused.json().message).toMatch(/already ended/i);
  });

  it("refuses a hand-typed expiry because expiry is derived from the period", async () => {
    const created = await post(`/projects/${mainProject}/insurance/policies`, policyPayload());
    const id = created.json().id as string;
    await post(`/projects/${mainProject}/insurance/policies/${id}/status`, { status: "active" });
    const res = await post(`/projects/${mainProject}/insurance/policies/${id}/status`, {
      status: "expired",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/derived from the policy period/i);
  });

  it("rejects a transition the lifecycle does not allow", async () => {
    const created = await post(`/projects/${mainProject}/insurance/policies`, policyPayload());
    const res = await post(
      `/projects/${mainProject}/insurance/policies/${created.json().id}/status`,
      { status: "lapsed" },
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/Cannot transition a draft policy to lapsed/);
  });

  it("deletes a draft policy but keeps an active one on the record", async () => {
    const draft = await post(`/projects/${mainProject}/insurance/policies`, policyPayload());
    const draftId = draft.json().id as string;
    expect((await del(`/projects/${mainProject}/insurance/policies/${draftId}`)).statusCode).toBe(
      204,
    );

    const live = await activePolicy(mainProject);
    const refused = await del(`/projects/${mainProject}/insurance/policies/${live}`);
    expect(refused.statusCode).toBe(400);
    expect(refused.json().message).toMatch(/Only a draft policy can be deleted/);
  });

  it("carries a company-level policy with no project and shows it on the project's programme", async () => {
    const res = await post("/insurance/policies", policyPayload({ policyType: "employers_liability" }));
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.projectId).toBeNull();
    expect(body.number).toMatch(/^CPOL-\d{4}$/);

    const activated = await post(`/insurance/policies/${body.id}/status`, { status: "active" });
    expect(activated.statusCode).toBe(200);

    // it is visible from inside a project: an owner-controlled programme
    // covers every project under it
    const projectView = await get(`/projects/${mainProject}/insurance/policies`);
    expect(projectView.statusCode).toBe(200);
    const ids = (projectView.json().items as { id: string }[]).map((p) => p.id);
    expect(ids).toContain(body.id);

    // and a project policy cannot be edited through the company route
    const projectPolicy = await post(
      `/projects/${mainProject}/insurance/policies`,
      policyPayload(),
    );
    const wrongRoute = await patch(`/insurance/policies/${projectPolicy.json().id}`, {
      insurer: "Other Re",
    });
    expect(wrongRoute.statusCode).toBe(400);
    expect(wrongRoute.json().message).toMatch(/project policy/i);
  });

  it("serves the company programme view across projects with scope labelled", async () => {
    const res = await get("/insurance/policies?pageSize=200");
    expect(res.statusCode).toBe(200);
    const items = res.json().items as { scope: string; projectId: string | null }[];
    expect(items.length).toBeGreaterThan(0);
    expect(items.some((p) => p.scope === "company" && p.projectId === null)).toBe(true);
    expect(items.some((p) => p.scope === "project")).toBe(true);

    const onlyCompany = await get("/insurance/policies?companyLevelOnly=true");
    expect(
      (onlyCompany.json().items as { projectId: string | null }[]).every(
        (p) => p.projectId === null,
      ),
    ).toBe(true);
  });
});

/* ================================================================== */
/* Certificates                                                        */
/* ================================================================== */

describe("certificates as evidence (#780-781, ADR 0004)", () => {
  let policyId: string;
  let certId: string;

  it("records a certificate against a vendor and the policy it evidences", async () => {
    policyId = await activePolicy(mainProject, {
      policyType: "employers_liability",
      policyNumber: "EL/2026/1",
    });
    const res = await post(`/projects/${mainProject}/insurance/certificates`, {
      policyId,
      vendorId,
      subjectName: "Groundworks Ltd",
      policyType: "employers_liability",
      certificateNumber: "COI-1",
      insurer: "Acme Re",
      limitOfIndemnity: 5_000_000,
      validFrom: daysFromToday(-10),
      validTo: daysFromToday(200),
    });
    expect(res.statusCode).toBe(201);
    certId = res.json().id as string;
    expect(res.json().inDate).toBe(true);
    expect(res.json().verified).toBe(false);
    // the policy author submitted the evidence too — recorded, not blocked
    expect(res.json().selfEvidenced).toBe(true);
  });

  it("refuses a certificate whose type contradicts the policy it is filed against", async () => {
    const res = await post(`/projects/${mainProject}/insurance/certificates`, {
      policyId,
      vendorId,
      subjectName: "Groundworks Ltd",
      policyType: "marine_cargo",
      validFrom: daysFromToday(-1),
      validTo: daysFromToday(100),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/does not match the linked policy/i);
  });

  it("refuses an inverted validity window and an unknown vendor", async () => {
    const inverted = await post(`/projects/${mainProject}/insurance/certificates`, {
      subjectName: "X",
      policyType: "employers_liability",
      validFrom: daysFromToday(10),
      validTo: daysFromToday(1),
    });
    expect(inverted.statusCode).toBe(400);
    expect(inverted.json().message).toMatch(/inverted/i);

    const badVendor = await post(`/projects/${mainProject}/insurance/certificates`, {
      subjectName: "X",
      vendorId: "ven_does_not_exist",
      policyType: "employers_liability",
      validFrom: daysFromToday(-1),
      validTo: daysFromToday(100),
    });
    expect(badVendor.statusCode).toBe(400);
    expect(badVendor.json().message).toMatch(/vendor/i);
  });

  it("will not let the submitter verify their own certificate, but will let another actor", async () => {
    const self = await post(
      `/projects/${mainProject}/insurance/certificates/${certId}/verify`,
      { verificationMethod: "insurer_confirmation" },
    );
    expect(self.statusCode).toBe(403);
    expect(self.json().message).toMatch(/not independent of its submitter/i);

    const independent = await post(
      `/projects/${mainProject}/insurance/certificates/${certId}/verify`,
      { verificationMethod: "insurer_confirmation", reference: "call ref 88" },
      verifier.headers,
    );
    expect(independent.statusCode).toBe(200);
    expect(independent.json().verified).toBe(true);
    expect(independent.json().verifiedBy).toBe(verifier.userId);
    expect(independent.json().independentVerification).toBe(true);
    expect(independent.json().verificationStrength).toMatch(/insurer/i);
  });

  it("drops a verification when the substance of the evidence is edited", async () => {
    const res = await patch(`/projects/${mainProject}/insurance/certificates/${certId}`, {
      limitOfIndemnity: 2_000_000,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().verifiedAt).toBeNull();
    expect(res.json().verified).toBe(false);
  });

  it("stores the certificate file content-addressed and serves it back with its sha256", async () => {
    const boundary = "----constructostest";
    const content = "CERTIFICATE OF INSURANCE — Groundworks Ltd";
    const payload =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="coi.txt"\r\n` +
      `Content-Type: text/plain\r\n\r\n${content}\r\n--${boundary}--\r\n`;
    const upload = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${mainProject}/insurance/certificates/${certId}/file`,
      headers: {
        ...owner.headers,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });
    expect(upload.statusCode).toBe(201);
    const sha = upload.json().file.sha256 as string;
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    expect(upload.json().fileSha256).toBe(sha);

    const download = await get(
      `/projects/${mainProject}/insurance/certificates/${certId}/file`,
    );
    expect(download.statusCode).toBe(200);
    expect(download.body).toBe(content);
    expect(download.headers["x-content-sha256"]).toBe(sha);
  });
});

/* ================================================================== */
/* The expiry sweep                                                    */
/* ================================================================== */

describe("lazy expiry sweep", () => {
  it("expires a lapsed policy and raises policy_lapsed_during_works exactly once", async () => {
    const id = newId("pol");
    await app.db.insert(insurancePolicies).values({
      id,
      companyId: owner.companyId,
      projectId: sweepProject,
      number: "POL-LAPSE",
      policyType: "contractors_all_risks",
      insurer: "Acme Re",
      policyNumber: "CAR/LAPSED",
      periodStart: daysFromToday(-400),
      periodEnd: daysFromToday(-3),
      status: "active",
      createdBy: owner.userId,
    });

    const first = await get(`/projects/${sweepProject}/insurance/policies`);
    expect(first.statusCode).toBe(200);
    const swept = (first.json().items as { id: string; status: string }[]).find(
      (p) => p.id === id,
    );
    expect(swept?.status).toBe("expired");
    expect(await signalsFor("policy_lapsed_during_works", id)).toHaveLength(1);

    // repeated reads are idempotent — the same lapse is never raised twice
    await get(`/projects/${sweepProject}/insurance/policies`);
    await get(`/projects/${sweepProject}/insurance/policies`);
    await get(`/projects/${sweepProject}/insurance/summary`);
    expect(await signalsFor("policy_lapsed_during_works", id)).toHaveLength(1);

    const raised = (await signalsFor("policy_lapsed_during_works", id))[0]!;
    expect(raised.severity).toBe("critical");
    expect(raised.explanation).toMatch(/uninsured/i);
  });

  it("expires a stale certificate and raises insurance_certificate_expired exactly once", async () => {
    const id = newId("cert");
    await app.db.insert(insuranceCertificates).values({
      id,
      companyId: owner.companyId,
      projectId: sweepProject,
      vendorId,
      subjectName: "Groundworks Ltd",
      policyType: "employers_liability",
      validFrom: daysFromToday(-370),
      validTo: daysFromToday(-2),
      status: "active",
      createdBy: owner.userId,
    });

    const first = await get(`/projects/${sweepProject}/insurance/certificates`);
    expect(first.statusCode).toBe(200);
    const swept = (first.json().items as { id: string; status: string }[]).find(
      (c) => c.id === id,
    );
    expect(swept?.status).toBe("expired");
    expect(await signalsFor("insurance_certificate_expired", id)).toHaveLength(1);

    await get(`/projects/${sweepProject}/insurance/certificates`);
    await get(`/projects/${sweepProject}/insurance/certificates/${id}`);
    expect(await signalsFor("insurance_certificate_expired", id)).toHaveLength(1);
  });

  it("does not raise a lapse signal for a policy that expired after the works closed", async () => {
    const closed = await makeProject("Closed out", "closed");
    const id = newId("pol");
    await app.db.insert(insurancePolicies).values({
      id,
      companyId: owner.companyId,
      projectId: closed,
      number: "POL-CLOSED",
      policyType: "contractors_all_risks",
      insurer: "Acme Re",
      policyNumber: "CAR/CLOSED",
      periodStart: daysFromToday(-400),
      periodEnd: daysFromToday(-5),
      status: "active",
      createdBy: owner.userId,
    });
    const res = await get(`/projects/${closed}/insurance/policies`);
    expect(res.statusCode).toBe(200);
    // still expired — expiry is a fact — but no signal, because nobody is at risk
    expect((res.json().items as { status: string }[])[0]?.status).toBe("expired");
    expect(await signalsFor("policy_lapsed_during_works", id)).toHaveLength(0);
  });

  it("raises bond_demand_deadline_passed once for a bond whose demand window has closed", async () => {
    const id = newId("bnd");
    await app.db.insert(bonds).values({
      id,
      companyId: owner.companyId,
      projectId: sweepProject,
      number: "BND-DEAD",
      bondType: "performance",
      guarantor: "Surety Co",
      amount: 500_000,
      currency: "GBP",
      isOnDemand: 1,
      expiryAt: daysFromToday(20),
      demandDeadline: daysFromToday(-4),
      status: "active",
      createdBy: owner.userId,
    });
    const first = await get(`/projects/${sweepProject}/insurance/bonds`);
    expect(first.statusCode).toBe(200);
    expect(await signalsFor("bond_demand_deadline_passed", id)).toHaveLength(1);
    await get(`/projects/${sweepProject}/insurance/bonds`);
    await get(`/projects/${sweepProject}/insurance/bonds/${id}`);
    expect(await signalsFor("bond_demand_deadline_passed", id)).toHaveLength(1);
    expect((await signalsFor("bond_demand_deadline_passed", id))[0]!.explanation).toMatch(
      /will not be honoured/i,
    );
  });
});

/* ================================================================== */
/* Cover gaps                                                          */
/* ================================================================== */

describe("supply-chain cover gaps (#778)", () => {
  it("says so, rather than reporting zero gaps, when no cover requirement is recorded", async () => {
    const bare = await makeProject("No requirements recorded");
    const res = await get(`/projects/${bare}/insurance/summary`);
    expect(res.statusCode).toBe(200);
    expect(res.json().cover.requirementsKnown).toBe(false);
    expect(res.json().cover.gaps).toEqual([]);
    expect(res.json().cover.note).toMatch(/cannot be computed/i);
  });

  it("raises insurance_cover_gap once for a vendor at work with no evidence of required cover", async () => {
    // the contractual requirement: a policy type carrying requiredByClause
    await activePolicy(gapProject, {
      policyType: "employers_liability",
      policyNumber: "EL/GAP",
      requiredByClause: "FIDIC 18.2",
    });
    // the vendor at work: workers recorded on site under their name
    await app.db.insert(workers).values({
      id: newId("wkr"),
      companyId: owner.companyId,
      projectId: gapProject,
      reference: "W-1",
      fullName: "A Worker",
      vendorId,
      status: "active",
      createdBy: owner.userId,
    });

    const key = `${gapProject}:${vendorId}:employers_liability`;
    const first = await get(`/projects/${gapProject}/insurance/policies`);
    expect(first.statusCode).toBe(200);
    const raised = await signalsFor("insurance_cover_gap", key);
    expect(raised).toHaveLength(1);
    expect(raised[0]!.title).toMatch(/Groundworks Ltd/);
    expect(raised[0]!.explanation).toMatch(/uninsured link/i);

    await get(`/projects/${gapProject}/insurance/certificates`);
    await get(`/projects/${gapProject}/insurance/summary`);
    expect(await signalsFor("insurance_cover_gap", key)).toHaveLength(1);
  });

  it("reports the gap in the expiry radar with the reason and the vendor named", async () => {
    const res = await get(`/projects/${gapProject}/insurance/expiring?days=30`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.coverRequirementsKnown).toBe(true);
    expect(body.requiredTypesSource).toBe("policies_with_required_by_clause");
    const gap = (body.coverGaps as { vendorId: string; reason: string; vendorName: string }[]).find(
      (g) => g.vendorId === vendorId,
    );
    expect(gap?.reason).toBe("no_certificate");
    expect(gap?.vendorName).toBe("Groundworks Ltd");
  });

  it("closes the gap once an in-date certificate exists for that vendor and type", async () => {
    const created = await post(`/projects/${gapProject}/insurance/certificates`, {
      vendorId,
      subjectName: "Groundworks Ltd",
      policyType: "employers_liability",
      validFrom: daysFromToday(-5),
      validTo: daysFromToday(180),
    });
    expect(created.statusCode).toBe(201);
    const res = await get(`/projects/${gapProject}/insurance/expiring?days=30`);
    const gaps = (res.json().coverGaps as { vendorId: string }[]).filter(
      (g) => g.vendorId === vendorId,
    );
    expect(gaps).toHaveLength(0);
    // in date but nobody independent has confirmed it — reported separately
    const unverified = (res.json().coverUnverified as { vendorId: string }[]).filter(
      (g) => g.vendorId === vendorId,
    );
    expect(unverified).toHaveLength(1);
  });

  it("honours an explicit requiredTypes query over the derived requirement", async () => {
    const res = await get(
      `/projects/${gapProject}/insurance/expiring?days=30&requiredTypes=professional_indemnity`,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().requiredTypesSource).toBe("query");
    expect(
      (res.json().coverGaps as { policyType: string }[]).every(
        (g) => g.policyType === "professional_indemnity",
      ),
    ).toBe(true);

    const bad = await get(`/projects/${gapProject}/insurance/expiring?requiredTypes=nonsense`);
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toMatch(/Unknown policy type/);
  });
});

/* ================================================================== */
/* Bonds                                                               */
/* ================================================================== */

describe("bonds and demands (#790-794)", () => {
  let bondId: string;

  it("registers a bond with a reduction schedule and refuses a deadline after expiry", async () => {
    const bad = await post(`/projects/${bondProject}/insurance/bonds`, {
      bondType: "performance",
      guarantor: "Surety Co",
      amount: 1_000_000,
      expiryAt: daysFromToday(100),
      demandDeadline: daysFromToday(120),
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toMatch(/falls after expiryAt/);

    const res = await post(`/projects/${bondProject}/insurance/bonds`, {
      bondType: "performance",
      guarantor: "Surety Co",
      bondNumber: "SUR-1",
      principalVendorId: otherVendorId,
      amount: 1_000_000,
      currency: "GBP",
      isOnDemand: true,
      issuedAt: daysFromToday(-100),
      expiryAt: daysFromToday(200),
      demandDeadline: daysFromToday(150),
      reductionSchedule: [
        { trigger: "practical_completion", reducesToPercent: 50 },
        { trigger: "final_account", reducesToPercent: 10 },
      ],
    });
    expect(res.statusCode).toBe(201);
    bondId = res.json().id as string;
    expect(res.json().number).toBe("BND-0001");
    expect(res.json().exposure.currentAmount).toBe(1_000_000);
    expect(res.json().status).toBe("draft");
  });

  it("walks the bond into force and steps it down on a milestone", async () => {
    await post(`/projects/${bondProject}/insurance/bonds/${bondId}/status`, {
      status: "issued",
    });
    const active = await post(`/projects/${bondProject}/insurance/bonds/${bondId}/status`, {
      status: "active",
    });
    expect(active.statusCode).toBe(200);

    const reduced = await post(`/projects/${bondProject}/insurance/bonds/${bondId}/reduce`, {
      trigger: "practical_completion",
    });
    expect(reduced.statusCode).toBe(200);
    expect(reduced.json().exposure.appliedPercent).toBe(50);
    expect(reduced.json().exposure.currentAmount).toBe(500_000);

    const again = await post(`/projects/${bondProject}/insurance/bonds/${bondId}/reduce`, {
      trigger: "practical_completion",
    });
    expect(again.statusCode).toBe(400);
    expect(again.json().message).toMatch(/already recorded/i);

    const unknown = await post(`/projects/${bondProject}/insurance/bonds/${bondId}/reduce`, {
      trigger: "not_a_milestone",
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().message).toMatch(/No reduction step/);
  });

  it("refuses a demand larger than the bond's reduced value", async () => {
    const res = await post(`/projects/${bondProject}/insurance/bonds/${bondId}/call`, {
      amount: 600_000,
      reason: "Failure to complete",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/exceeds the bond's current value/);
  });

  it("records a demand inside the window and marks the bond called", async () => {
    const res = await post(`/projects/${bondProject}/insurance/bonds/${bondId}/call`, {
      amount: 400_000,
      reason: "Failure to complete by the completion date",
      evidenceRefs: { contractEventId: "cev_1", certificateOfNonCompletion: "cnc_1" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().bond.status).toBe("called");
    expect(res.json().call.outcome).toBe("pending");
    expect(res.json().daysBeforeDeadline).toBeGreaterThan(0);

    const outcome = await post(
      `/projects/${bondProject}/insurance/bond-calls/${res.json().call.id}/outcome`,
      { outcome: "paid" },
    );
    expect(outcome.statusCode).toBe(400);
    expect(outcome.json().message).toMatch(/proceedsAmount/);

    const paid = await post(
      `/projects/${bondProject}/insurance/bond-calls/${res.json().call.id}/outcome`,
      { outcome: "paid", proceedsAmount: 400_000, proceedsReceivedAt: today() },
    );
    expect(paid.statusCode).toBe(200);
    expect(paid.json().outcome).toBe("paid");
  });

  it("REFUSES a demand made after the demand deadline, naming the deadline", async () => {
    const id = newId("bnd");
    const deadline = daysFromToday(-7);
    await app.db.insert(bonds).values({
      id,
      companyId: owner.companyId,
      projectId: bondProject,
      number: "BND-LATE",
      bondType: "advance_payment",
      guarantor: "Surety Co",
      amount: 250_000,
      currency: "GBP",
      isOnDemand: 1,
      expiryAt: daysFromToday(30),
      demandDeadline: deadline,
      status: "active",
      createdBy: owner.userId,
    });
    const res = await post(`/projects/${bondProject}/insurance/bonds/${id}/call`, {
      amount: 100_000,
      reason: "Advance payment not recouped",
      evidenceRefs: { valuationId: "val_1" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain(deadline);
    expect(res.json().message).toMatch(/out of time/i);
    expect(res.json().details.daysLate).toBe(7);

    // nothing was recorded — the bond is untouched
    const [row] = await app.db.select().from(bonds).where(eq(bonds.id, id));
    expect(row?.status).toBe("active");
  });

  it("requires evidence before a demand under a conditional (not on-demand) bond", async () => {
    const created = await post(`/projects/${bondProject}/insurance/bonds`, {
      bondType: "retention",
      guarantor: "Surety Co",
      amount: 100_000,
      isOnDemand: false,
      issuedAt: daysFromToday(-10),
      expiryAt: daysFromToday(200),
      demandDeadline: daysFromToday(150),
    });
    const id = created.json().id as string;
    await post(`/projects/${bondProject}/insurance/bonds/${id}/status`, { status: "issued" });
    await post(`/projects/${bondProject}/insurance/bonds/${id}/status`, { status: "active" });

    const bare = await post(`/projects/${bondProject}/insurance/bonds/${id}/call`, {
      amount: 50_000,
      reason: "Defects not made good",
    });
    expect(bare.statusCode).toBe(400);
    expect(bare.json().message).toMatch(/conditional/i);

    const evidenced = await post(`/projects/${bondProject}/insurance/bonds/${id}/call`, {
      amount: 50_000,
      reason: "Defects not made good",
      evidenceRefs: { punchItemIds: ["pi_1", "pi_2"] },
    });
    expect(evidenced.statusCode).toBe(201);
  });

  it("releases a bond once and refuses a second release", async () => {
    const created = await post(`/projects/${bondProject}/insurance/bonds`, {
      bondType: "bid",
      guarantor: "Surety Co",
      amount: 50_000,
      issuedAt: daysFromToday(-30),
      expiryAt: daysFromToday(90),
    });
    const id = created.json().id as string;
    await post(`/projects/${bondProject}/insurance/bonds/${id}/status`, { status: "issued" });

    const released = await post(`/projects/${bondProject}/insurance/bonds/${id}/release`, {
      reason: "Contract awarded elsewhere",
    });
    expect(released.statusCode).toBe(200);
    expect(released.json().status).toBe("released");
    expect(released.json().releasedAt).toBe(today());

    const again = await post(`/projects/${bondProject}/insurance/bonds/${id}/release`, {});
    expect(again.statusCode).toBe(400);
    expect(again.json().message).toMatch(/already released/i);
  });
});

/* ================================================================== */
/* Claims and the notification obligation                              */
/* ================================================================== */

describe("claim notification as an obligation (#783-789)", () => {
  let policyId: string;

  it("computes the deadline off the aware date and materialises it as an obligation", async () => {
    policyId = await activePolicy(claimProject, {
      policyType: "third_party_liability",
      policyNumber: "TPL/2026",
      notificationDays: 21,
    });
    const awareDate = daysFromToday(-2);
    const res = await post(`/projects/${claimProject}/insurance/claims`, {
      policyId,
      title: "Scaffold collapse — third party vehicle damage",
      incidentDate: daysFromToday(-4),
      awareDate,
      reserve: 75_000,
      currency: "GBP",
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.number).toBe("ICL-0001");
    expect(body.notificationDueAt).toBe(addDaysISO(awareDate, 21));
    expect(body.notificationRule.notificationDays).toBe(21);
    expect(body.obligationId).toBeTruthy();

    const [obl] = await app.db
      .select()
      .from(obligations)
      .where(eq(obligations.id, body.obligationId as string));
    expect(obl).toBeTruthy();
    expect(obl!.status).toBe("open");
    expect(String(obl!.deadline).slice(0, 10)).toBe(addDaysISO(awareDate, 21));
    expect(obl!.sourceClause).toMatch(/^insurance /);
    expect(obl!.trigger).toMatch(/Notify insurer/);
  });

  it("refuses an aware date that precedes the incident", async () => {
    const res = await post(`/projects/${claimProject}/insurance/claims`, {
      policyId,
      title: "Impossible",
      incidentDate: daysFromToday(-2),
      awareDate: daysFromToday(-5),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/cannot become aware/i);
  });

  it("creates no deadline, and says why, when the policy records no notification period", async () => {
    const silent = await activePolicy(claimProject, {
      policyType: "professional_indemnity",
      policyNumber: "PI/2026",
      notificationDays: null,
    });
    const res = await post(`/projects/${claimProject}/insurance/claims`, {
      policyId: silent,
      title: "Design defect discovered",
      incidentDate: daysFromToday(-30),
      awareDate: daysFromToday(-1),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().notificationDueAt).toBeNull();
    expect(res.json().obligationId).toBeNull();
    expect(res.json().notificationRule.note).toMatch(/records no notification period/i);
  });

  it("discharges the obligation when notification is given in time", async () => {
    const created = await post(`/projects/${claimProject}/insurance/claims`, {
      policyId,
      title: "Water ingress to finished works",
      incidentDate: daysFromToday(-2),
      awareDate: daysFromToday(-1),
      reserve: 10_000,
    });
    const claimId = created.json().id as string;
    const res = await post(`/projects/${claimProject}/insurance/claims/${claimId}/notify`, {
      method: "broker",
      reference: "broker email 12:04",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().late).toBe(false);
    expect(res.json().notifiedAt).toBe(today());
    expect(res.json().consequence).toMatch(/in time/i);

    const [obl] = await app.db
      .select()
      .from(obligations)
      .where(eq(obligations.id, created.json().obligationId as string));
    expect(obl!.status).toBe("satisfied");
    expect(await signalsFor("insurance_notification_missed", claimId)).toHaveLength(0);
  });

  it("breaches the obligation and raises one critical signal when notification is late", async () => {
    const awareDate = daysFromToday(-40);
    const created = await post(`/projects/${claimProject}/insurance/claims`, {
      policyId,
      title: "Damage to neighbouring wall",
      incidentDate: daysFromToday(-42),
      awareDate,
      reserve: 120_000,
    });
    const claimId = created.json().id as string;
    const obligationId = created.json().obligationId as string;
    expect(created.json().notificationDueAt).toBe(addDaysISO(awareDate, 21));

    const res = await post(`/projects/${claimProject}/insurance/claims/${claimId}/notify`, {
      method: "email",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().late).toBe(true);
    expect(res.json().daysLate).toBe(19);
    expect(res.json().consequence).toMatch(/condition precedent/i);

    const [obl] = await app.db
      .select()
      .from(obligations)
      .where(eq(obligations.id, obligationId));
    expect(obl!.status).toBe("breached");

    const raised = await signalsFor("insurance_notification_missed", claimId);
    expect(raised).toHaveLength(1);
    expect(raised[0]!.severity).toBe("critical");
    expect(raised[0]!.explanation).toMatch(/condition precedent/i);
    expect(raised[0]!.explanation).toMatch(/fatal to the/i);

    // a second notification is refused, so the signal cannot be raised twice
    const second = await post(`/projects/${claimProject}/insurance/claims/${claimId}/notify`, {});
    expect(second.statusCode).toBe(400);
    expect(second.json().message).toMatch(/already notified/i);
    await get(`/projects/${claimProject}/insurance/claims`);
    await get(`/projects/${claimProject}/insurance/claims/${claimId}`);
    expect(await signalsFor("insurance_notification_missed", claimId)).toHaveLength(1);
  });

  it("will not acknowledge a claim the insurer has not been told about", async () => {
    const created = await post(`/projects/${claimProject}/insurance/claims`, {
      policyId,
      title: "Unnotified loss",
      incidentDate: daysFromToday(-2),
      awareDate: daysFromToday(-1),
    });
    const res = await post(
      `/projects/${claimProject}/insurance/claims/${created.json().id}/status`,
      { status: "acknowledged" },
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/before it has been notified/i);
  });

  it("requires a ground for repudiation and a figure and date for settlement", async () => {
    const created = await post(`/projects/${claimProject}/insurance/claims`, {
      policyId,
      title: "Plant theft",
      incidentDate: daysFromToday(-3),
      awareDate: daysFromToday(-2),
      reserve: 30_000,
    });
    const claimId = created.json().id as string;
    await post(`/projects/${claimProject}/insurance/claims/${claimId}/notify`, {});
    await post(`/projects/${claimProject}/insurance/claims/${claimId}/status`, {
      status: "acknowledged",
    });
    await post(`/projects/${claimProject}/insurance/claims/${claimId}/status`, {
      status: "under_assessment",
    });

    const bareRepudiation = await post(
      `/projects/${claimProject}/insurance/claims/${claimId}/status`,
      { status: "repudiated" },
    );
    expect(bareRepudiation.statusCode).toBe(400);
    expect(bareRepudiation.json().message).toMatch(/ground relied on/i);

    const accepted = await post(
      `/projects/${claimProject}/insurance/claims/${claimId}/status`,
      { status: "accepted" },
    );
    expect(accepted.statusCode).toBe(200);

    const bareSettlement = await post(
      `/projects/${claimProject}/insurance/claims/${claimId}/status`,
      { status: "settled" },
    );
    expect(bareSettlement.statusCode).toBe(400);
    expect(bareSettlement.json().message).toMatch(/settledAmount and settledAt/);

    const settled = await post(
      `/projects/${claimProject}/insurance/claims/${claimId}/status`,
      { status: "settled", settledAmount: 24_500, settledAt: today() },
    );
    expect(settled.statusCode).toBe(200);
    expect(settled.json().settledAmount).toBe(24_500);

    // terminal: nothing moves out of settled
    const after = await post(`/projects/${claimProject}/insurance/claims/${claimId}/status`, {
      status: "withdrawn",
    });
    expect(after.statusCode).toBe(400);
    expect(after.json().message).toMatch(/Cannot transition a settled claim/);
  });

  it("records a repudiation with its ground and closes the notification obligation", async () => {
    const created = await post(`/projects/${claimProject}/insurance/claims`, {
      policyId,
      title: "Excluded peril loss",
      incidentDate: daysFromToday(-3),
      awareDate: daysFromToday(-2),
    });
    const claimId = created.json().id as string;
    await post(`/projects/${claimProject}/insurance/claims/${claimId}/notify`, {});
    await post(`/projects/${claimProject}/insurance/claims/${claimId}/status`, {
      status: "acknowledged",
    });
    await post(`/projects/${claimProject}/insurance/claims/${claimId}/status`, {
      status: "under_assessment",
    });
    const res = await post(`/projects/${claimProject}/insurance/claims/${claimId}/status`, {
      status: "repudiated",
      repudiationReason: "Faulty workmanship exclusion, clause 4.2(b)",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().repudiationReason).toMatch(/clause 4.2/);
    expect(res.json().status).toBe("repudiated");
  });
});

/* ================================================================== */
/* Programme summary                                                   */
/* ================================================================== */

describe("programme summary (#773, #786, #795-796)", () => {
  it("reports cover by type, limits, bond exposure, claims and the live counts for a project", async () => {
    const res = await get(`/projects/${claimProject}/insurance/summary`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.scope).toBe("project");
    expect(body.projectId).toBe(claimProject);
    expect(body.asOf).toBe(today());

    const tpl = (body.cover.byType as { policyType: string; covered: boolean; totalLimits: { currency: string; total: number }[] }[]).find(
      (t) => t.policyType === "third_party_liability",
    );
    expect(tpl?.covered).toBe(true);
    expect(tpl?.totalLimits[0]?.currency).toBe("GBP");
    expect(tpl?.totalLimits[0]?.total).toBe(10_000_000);

    expect(body.claims.total).toBeGreaterThan(0);
    expect(body.claims.byStatus.settled).toBe(1);
    expect(body.claims.byStatus.repudiated).toBe(1);
    const gbp = (body.claims.totals as { currency: string; reserve: number | null; settled: number | null; claimsWithoutReserve: number }[]).find(
      (t) => t.currency === "GBP",
    );
    expect(gbp?.reserve).toBeGreaterThan(0);
    expect(gbp?.settled).toBe(24_500);
    expect(gbp?.claimsWithoutReserve).toBeGreaterThan(0);
    expect(body.claims.notificationsMissed).toBe(1);
    expect(body.claims.notificationDeadlineUnknown).toBe(1);
    expect(body.claims.note).toMatch(/no computed notification deadline/i);

    expect(body.obligations.breached).toBe(1);
    expect(body.obligations.total).toBeGreaterThan(0);
    expect(body.signals.byDetector.insurance_notification_missed).toBe(1);
  });

  it("says a limit total cannot be computed rather than reporting zero", async () => {
    const project = await makeProject("Unlimited-limit programme");
    await activePolicy(project, {
      policyType: "decennial",
      policyNumber: "DEC/1",
      limitOfIndemnity: null,
    });
    const res = await get(`/projects/${project}/insurance/summary`);
    const dec = (res.json().cover.byType as { policyType: string; totalLimits: unknown[]; limitNote: string | null }[]).find(
      (t) => t.policyType === "decennial",
    );
    expect(dec?.totalLimits).toEqual([]);
    expect(dec?.limitNote).toMatch(/cannot be computed/i);
  });

  it("aggregates bond exposure per currency and never across currencies", async () => {
    const res = await get(`/projects/${bondProject}/insurance/summary`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.bonds.total).toBeGreaterThan(0);
    const agg = body.bonds.aggregateExposure as { currency: string; currentExposure: number }[];
    expect(agg.every((a) => typeof a.currency === "string" && a.currency.length === 3)).toBe(true);
    expect(body.bonds.note).toMatch(/never summed across currencies/i);
    expect(body.bonds.called).toBeGreaterThan(0);
    expect(body.bonds.released).toBeGreaterThan(0);

    // surety capacity utilisation (#795) — with an explicit refusal to imply
    // headroom (#796), which needs a facility limit nothing records
    const surety = (body.bonds.byGuarantor as { guarantor: string; currentExposure: number }[]).find(
      (g) => g.guarantor === "Surety Co",
    );
    expect(surety?.currentExposure).toBeGreaterThan(0);
    expect(body.bonds.headroomNote).toMatch(/not reported/i);
  });

  it("serves a company-wide programme summary spanning projects", async () => {
    const res = await get("/insurance/summary");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.scope).toBe("company");
    expect(body.projectId).toBeNull();
    expect(body.policies.companyLevel).toBeGreaterThan(0);
    expect(body.cover.requirementsKnown).toBe(true);
    expect(body.signals.total).toBeGreaterThan(0);
    expect(Object.keys(body.signals.byDetector)).toContain("insurance_cover_gap");
  });

  it("serves the company-wide expiry radar", async () => {
    const res = await get("/insurance/expiring?days=400");
    expect(res.statusCode).toBe(200);
    expect(res.json().scope).toBe("company");
    expect(res.json().windowDays).toBe(400);
    expect(Array.isArray(res.json().policiesExpiring)).toBe(true);
    expect(res.json().actionableCount).toBeGreaterThanOrEqual(0);
  });
});

/* ================================================================== */
/* Isolation and permissions                                           */
/* ================================================================== */

describe("tenant isolation and permission enforcement", () => {
  it("hides another company's insurance entirely", async () => {
    const foreign = await get(`/projects/${mainProject}/insurance/policies`, stranger.headers);
    expect([403, 404]).toContain(foreign.statusCode);

    const foreignSummary = await get(
      `/projects/${mainProject}/insurance/summary`,
      stranger.headers,
    );
    expect([403, 404]).toContain(foreignSummary.statusCode);

    // the stranger's own company programme is empty despite ours being full
    const own = await get("/insurance/policies", stranger.headers);
    expect(own.statusCode).toBe(200);
    expect(own.json().total).toBe(0);

    const unauth = await app.inject({ method: "GET", url: "/api/v1/insurance/summary" });
    expect(unauth.statusCode).toBe(401);
  });

  it("does not let a record be reached through the wrong project", async () => {
    const created = await post(`/projects/${mainProject}/insurance/policies`, policyPayload());
    const id = created.json().id as string;
    const wrongProject = await get(`/projects/${bondProject}/insurance/policies/${id}`);
    expect(wrongProject.statusCode).toBe(404);

    const foreignPolicy = await get(`/insurance/policies/${id}`, stranger.headers);
    expect(foreignPolicy.statusCode).toBe(404);
  });

  it("lets a read-only member read but not write", async () => {
    const canRead = await get(`/projects/${permProject}/insurance/policies`, viewerHeaders);
    expect(canRead.statusCode).toBe(200);

    const cannotCreate = await post(
      `/projects/${permProject}/insurance/policies`,
      policyPayload(),
      viewerHeaders,
    );
    expect(cannotCreate.statusCode).toBe(403);
    expect(cannotCreate.json().message).toMatch(/standard access to insurance/i);

    const cannotDelete = await del(
      `/projects/${permProject}/insurance/policies/anything`,
      viewerHeaders,
    );
    expect(cannotDelete.statusCode).toBe(403);
  });

  it("keeps a member off projects they are not a member of", async () => {
    const res = await get(`/projects/${mainProject}/insurance/policies`, viewerHeaders);
    expect(res.statusCode).toBe(403);
  });
});

/* ================================================================== */
/* Ledger                                                              */
/* ================================================================== */

describe("ledger coverage", () => {
  it("has ledgered every consequential insurance mutation into an unbroken chain", async () => {
    // The assurance module's verifier is the one that normalises the stored
    // timestamp back to the form it was hashed in; lib/ledger's helper reports
    // false breaks on a Postgres round-trip.
    const chain = await get("/ledger/verify");
    expect(chain.statusCode).toBe(200);
    expect(chain.json().valid).toBe(true);
    expect(chain.json().count).toBeGreaterThan(20);

    const entries = await get("/ledger?objectType=insurance_claim&pageSize=200");
    expect(entries.statusCode).toBe(200);
    const claimRows = await app.db
      .select()
      .from(insuranceClaims)
      .where(eq(insuranceClaims.companyId, owner.companyId));
    const created = (entries.json().items as { action: string; objectId: string }[]).filter(
      (e) => e.action === "create",
    );
    expect(created).toHaveLength(claimRows.length);

    const bondCallEntries = await get("/ledger?objectType=bond_call&pageSize=200");
    expect((bondCallEntries.json().items as unknown[]).length).toBeGreaterThan(0);
  });
});
