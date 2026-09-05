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
  safetyIncidents,
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

/**
 * The sweep is now a SCHEDULED JOB, not a read side effect. Reads are pure, so
 * these tests trigger a cycle explicitly — which is also the point of the
 * change: a policy nobody opened used to never lapse in the record, and the
 * ledger attributed the resulting writes to whoever happened to open the page.
 */
async function runSweep(projectId?: string) {
  if (projectId) {
    const res = await post(`/projects/${projectId}/insurance/sweep`, {});
    expect(res.statusCode).toBe(200);
    return res.json() as { signals: number };
  }
  const res = await post("/insurance/sweep", {});
  expect(res.statusCode).toBe(200);
  return res.json() as { signals: number };
}

describe("scheduled expiry sweep", () => {
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

    // a read does NOT sweep any more: the record is untouched until the job runs
    const beforeSweep = await get(`/projects/${sweepProject}/insurance/policies`);
    expect(beforeSweep.statusCode).toBe(200);
    expect(await signalsFor("policy_lapsed_during_works", id)).toHaveLength(0);

    await runSweep(sweepProject);
    const first = await get(`/projects/${sweepProject}/insurance/policies`);
    expect(first.statusCode).toBe(200);
    const swept = (first.json().items as { id: string; status: string }[]).find(
      (p) => p.id === id,
    );
    expect(swept?.status).toBe("expired");
    expect(await signalsFor("policy_lapsed_during_works", id)).toHaveLength(1);

    // repeated sweeps are idempotent — the same lapse is never raised twice
    await runSweep(sweepProject);
    await runSweep(sweepProject);
    await app.scheduler.runNow("insurance.expiry");
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

    await runSweep(sweepProject);
    const first = await get(`/projects/${sweepProject}/insurance/certificates`);
    expect(first.statusCode).toBe(200);
    const swept = (first.json().items as { id: string; status: string }[]).find(
      (c) => c.id === id,
    );
    expect(swept?.status).toBe("expired");
    expect(await signalsFor("insurance_certificate_expired", id)).toHaveLength(1);

    await runSweep(sweepProject);
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
    await runSweep(closed);
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
    await runSweep(sweepProject);
    const first = await get(`/projects/${sweepProject}/insurance/bonds`);
    expect(first.statusCode).toBe(200);
    expect(await signalsFor("bond_demand_deadline_passed", id)).toHaveLength(1);
    await runSweep(sweepProject);
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
    await runSweep(gapProject);
    const raised = await signalsFor("insurance_cover_gap", key);
    expect(raised).toHaveLength(1);
    expect(raised[0]!.title).toMatch(/Groundworks Ltd/);
    expect(raised[0]!.explanation).toMatch(/uninsured link/i);

    await runSweep(gapProject);
    await runSweep(gapProject);
    expect(await signalsFor("insurance_cover_gap", key)).toHaveLength(1);
  });

  it("reports the gap in the expiry radar with the reason and the vendor named", async () => {
    const res = await get(`/projects/${gapProject}/insurance/expiring?days=30`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.coverRequirementsKnown).toBe(true);
    expect(body.requiredTypesSource).toBe("recorded_requirements");
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

/* ================================================================== */
/* WP-MEET upgrade — facilities, requirements, premiums, renewals,     */
/* wording checks, the payment-hold hook, and the audit bug fixes      */
/* ================================================================== */

describe("bonding line facilities (#796)", () => {
  let facilityId: string;

  it("refuses a facility to an ordinary member and accepts it from an admin", async () => {
    const denied = await post(
      "/insurance/facilities",
      { name: "Surety line", provider: "Surety Co", limitAmount: 5_000_000 },
      viewerHeaders,
    );
    expect(denied.statusCode).toBe(403);

    const res = await post("/insurance/facilities", {
      name: "Surety line",
      provider: "Surety Co",
      limitAmount: 5_000_000,
      currency: "GBP",
      permittedBondTypes: ["performance"],
      reviewDate: daysFromToday(45),
    });
    expect(res.statusCode).toBe(201);
    facilityId = res.json().id as string;
    expect(res.json().number).toBe("FAC-0001");
    expect(res.json().status).toBe("draft");
    expect(res.json().utilisation.headroom).toBe(5_000_000);
  });

  it("derives headroom from the live bonds drawn against the line and never across currencies", async () => {
    await post("/insurance/facilities/" + facilityId + "/status", { status: "active" });
    const gbp = newId("bnd");
    const usd = newId("bnd");
    await app.db.insert(bonds).values([
      {
        id: gbp,
        companyId: owner.companyId,
        projectId: bondProject,
        number: "BND-FAC-1",
        bondType: "performance",
        guarantor: "Surety Co",
        amount: 1_500_000,
        currency: "GBP",
        status: "active",
        facilityId,
        createdBy: owner.userId,
      },
      {
        id: usd,
        companyId: owner.companyId,
        projectId: bondProject,
        number: "BND-FAC-2",
        bondType: "performance",
        guarantor: "Surety Co",
        amount: 900_000,
        currency: "USD",
        status: "active",
        facilityId,
        createdBy: owner.userId,
      },
    ]);
    const res = await get(`/insurance/facilities/${facilityId}`);
    expect(res.statusCode).toBe(200);
    const u = res.json().utilisation;
    expect(u.drawnAmount).toBe(1_500_000);
    expect(u.headroom).toBe(3_500_000);
    expect(u.utilisationPct).toBe(30);
    expect(u.excludedForeignCurrency).toHaveLength(1);
    expect(u.reasons.join(" ")).toMatch(/different currency/i);
    expect(u.daysToReview).toBeGreaterThan(0);
  });

  it("refuses to close a facility with line still drawn", async () => {
    const res = await post(`/insurance/facilities/${facilityId}/status`, { status: "closed" });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/still drawn/i);
  });

  it("reports headroom by currency on the list and ledgers the facility", async () => {
    const res = await get("/insurance/facilities");
    expect(res.statusCode).toBe(200);
    const gbpLine = (res.json().headroomByCurrency as { currency: string; headroom: number }[]).find(
      (h) => h.currency === "GBP",
    );
    expect(gbpLine?.headroom).toBe(3_500_000);

    const ledger = await get("/ledger?objectType=bond_facility&pageSize=50");
    expect((ledger.json().items as unknown[]).length).toBeGreaterThan(0);
  });

  it("keeps a facility out of another tenant's reach", async () => {
    const foreign = await get(`/insurance/facilities/${facilityId}`, stranger.headers);
    expect([403, 404]).toContain(foreign.statusCode);
  });
});

describe("insurance requirements — a requirement belongs to a scope", () => {
  let reqProject: string;
  let otherProject: string;
  let reqId: string;

  it("records a requirement with the clause that demands it", async () => {
    reqProject = await makeProject("Requirements A");
    otherProject = await makeProject("Requirements B");
    const missingClause = await post(`/projects/${reqProject}/insurance/requirements`, {
      policyType: "professional_indemnity",
    });
    expect(missingClause.statusCode).toBe(400);

    const res = await post(`/projects/${reqProject}/insurance/requirements`, {
      policyType: "professional_indemnity",
      requiredByClause: "NEC4 X10.3",
      minimumLimit: 5_000_000,
      currency: "GBP",
      waiverOfSubrogation: true,
    });
    expect(res.statusCode).toBe(201);
    reqId = res.json().id as string;
    expect(res.json().status).toBe("required");
    expect(res.json().waiverOfSubrogation).toBe(1);
  });

  it("does NOT apply one project's requirement to another project's vendors", async () => {
    // a vendor at work on the OTHER project, with no PI evidence anywhere
    await app.db.insert(workers).values({
      id: newId("wkr"),
      companyId: owner.companyId,
      projectId: otherProject,
      reference: "W-REQ",
      fullName: "Another Worker",
      vendorId: otherVendorId,
      status: "active",
      createdBy: owner.userId,
    });
    await runSweep();
    const leaked = await signalsFor(
      "insurance_cover_gap",
      `${otherProject}:${otherVendorId}:professional_indemnity`,
    );
    expect(leaked).toHaveLength(0);

    // the same requirement recorded company-wide DOES reach the other project
    const companyWide = await post("/insurance/requirements", {
      policyType: "third_party_liability",
      requiredByClause: "Company standard 1",
    });
    expect(companyWide.statusCode).toBe(201);
    await runSweep();
    const reaches = await signalsFor(
      "insurance_cover_gap",
      `${otherProject}:${otherVendorId}:third_party_liability`,
    );
    expect(reaches).toHaveLength(1);
  });

  it("waives a requirement as a recorded decision, never as an edit", async () => {
    const patchStatus = await patch(
      `/projects/${reqProject}/insurance/requirements/${reqId}`,
      { status: "waived" },
    );
    // status is not in the patch schema, so it is simply not applied
    expect(patchStatus.statusCode).toBe(200);
    expect(patchStatus.json().status).toBe("required");

    const noReason = await post(
      `/projects/${reqProject}/insurance/requirements/${reqId}/waive`,
      {},
    );
    expect(noReason.statusCode).toBe(400);

    const waived = await post(`/projects/${reqProject}/insurance/requirements/${reqId}/waive`, {
      reason: "Design responsibility sits with the employer's own consultant",
    });
    expect(waived.statusCode).toBe(200);
    expect(waived.json().status).toBe("waived");
    expect(waived.json().waivedBy).toBe(owner.userId);

    const again = await post(`/projects/${reqProject}/insurance/requirements/${reqId}/waive`, {
      reason: "again",
    });
    expect(again.statusCode).toBe(409);
  });

  it("says the requirement set is unknown rather than reporting compliance", async () => {
    const bare = await makeProject("No requirement recorded");
    const res = await get(`/projects/${bare}/insurance/requirements`);
    expect(res.statusCode).toBe(200);
    expect(res.json().note).toMatch(/never 'compliant'/i);
  });
});

describe("policy wording checks against the contract", () => {
  let wProject: string;

  it("finds the shortfall, the missing endorsement and the absent class of cover", async () => {
    wProject = await makeProject("Wording checks");
    await post(`/projects/${wProject}/insurance/requirements`, {
      policyType: "professional_indemnity",
      requiredByClause: "NEC4 X10.3",
      minimumLimit: 10_000_000,
      currency: "GBP",
      waiverOfSubrogation: true,
    });
    await post(`/projects/${wProject}/insurance/requirements`, {
      policyType: "decennial",
      requiredByClause: "Special condition 4",
    });
    await activePolicy(wProject, {
      policyType: "professional_indemnity",
      policyNumber: "PI/WORDING",
      limitOfIndemnity: 2_000_000,
      conditions: [{ ref: "1", text: "Standard exclusions apply" }],
    });

    const res = await get(`/projects/${wProject}/insurance/wording-checks`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.requirements).toBe(2);
    expect(body.nonCompliant).toBe(2);
    const pi = (body.checks as { policyType: string; findings: { code: string }[] }[]).find(
      (c) => c.policyType === "professional_indemnity",
    )!;
    const codes = pi.findings.map((f) => f.code);
    expect(codes).toContain("limit_below_requirement");
    expect(codes).toContain("waiver_of_subrogation_missing");
    const dec = (body.checks as { policyType: string; findings: { code: string }[] }[]).find(
      (c) => c.policyType === "decennial",
    )!;
    expect(dec.findings[0]!.code).toBe("no_policy");
    expect(body.findingsBySeverity.critical).toBeGreaterThan(0);
  });

  it("refuses to call an unrecorded requirement set a clean bill of health", async () => {
    const bare = await makeProject("Wording — nothing recorded");
    const res = await get(`/projects/${bare}/insurance/wording-checks`);
    expect(res.json().requirements).toBe(0);
    expect(res.json().note).toMatch(/not a clean bill of health/i);
  });
});

describe("period cover against the works (#777)", () => {
  it("reports the uncovered days at each end and raises policy_period_gap once", async () => {
    const id = newId("prj");
    await app.db.insert(projects).values({
      id,
      companyId: owner.companyId,
      name: "Period gap",
      stage: "course_of_construction",
      startDate: daysFromToday(-200),
      finishDate: daysFromToday(200),
    });
    await post(`/projects/${id}/insurance/requirements`, {
      policyType: "contractors_all_risks",
      requiredByClause: "FIDIC 18.2",
    });
    await activePolicy(id, {
      policyType: "contractors_all_risks",
      policyNumber: "CAR/GAP",
      periodStart: daysFromToday(-150),
      periodEnd: daysFromToday(150),
    });

    const res = await get(`/projects/${id}/insurance/period-cover`);
    expect(res.statusCode).toBe(200);
    expect(res.json().gaps).toHaveLength(1);
    expect(res.json().gaps[0].uncoveredAtStartDays).toBe(50);
    expect(res.json().gaps[0].uncoveredAtEndDays).toBe(50);

    await runSweep(id);
    const key = res.json().gaps[0].key as string;
    expect(await signalsFor("policy_period_gap", key)).toHaveLength(1);
    await runSweep(id);
    expect(await signalsFor("policy_period_gap", key)).toHaveLength(1);
  });

  it("says the works dates are unknown rather than reporting full cover", async () => {
    const bare = await makeProject("No works dates");
    await post(`/projects/${bare}/insurance/requirements`, {
      policyType: "third_party_liability",
      requiredByClause: "Clause 1",
    });
    const res = await get(`/projects/${bare}/insurance/period-cover`);
    expect(res.json().gaps).toEqual([]);
    expect((res.json().reasons as string[]).join(" ")).toMatch(/no start and end date/i);
  });
});

describe("premium and claims experience (#782)", () => {
  let expProject: string;
  let expPolicy: string;

  it("computes the loss ratio per currency from premiums and claims", async () => {
    expProject = await makeProject("Experience");
    expPolicy = await activePolicy(expProject, { policyNumber: "CAR/EXP", currency: "GBP" });
    for (const p of [
      { amount: 150_000 },
      { amount: 50_000 },
      { kind: "return_premium", amount: 20_000 },
      { kind: "broker_fee", amount: 5_000 },
    ]) {
      const res = await post(
        `/projects/${expProject}/insurance/policies/${expPolicy}/premiums`,
        p,
      );
      expect(res.statusCode).toBe(201);
    }
    const claim = await post(`/projects/${expProject}/insurance/claims`, {
      policyId: expPolicy,
      title: "Storm damage",
      incidentDate: daysFromToday(-10),
      awareDate: daysFromToday(-8),
      reserve: 90_000,
      currency: "GBP",
    });
    expect(claim.statusCode).toBe(201);

    const res = await get(`/projects/${expProject}/insurance/experience`);
    expect(res.statusCode).toBe(200);
    const gbp = (res.json().byCurrency as { currency: string; premiumNet: number; lossRatioPct: number }[]).find(
      (b) => b.currency === "GBP",
    )!;
    expect(gbp.premiumNet).toBe(180_000);
    expect(gbp.claimsIncurred).toBe(90_000);
    expect(gbp.lossRatioPct).toBe(50);
    expect((res.json().byPolicyType as unknown[]).length).toBeGreaterThan(0);
  });

  it("refuses a ratio, with a reason, where no premium is recorded", async () => {
    const bare = await makeProject("No premium");
    const pol = await activePolicy(bare, { policyNumber: "CAR/NOPREM" });
    await post(`/projects/${bare}/insurance/claims`, {
      policyId: pol,
      title: "A loss",
      incidentDate: daysFromToday(-5),
      awareDate: daysFromToday(-4),
      reserve: 10_000,
    });
    const res = await get(`/projects/${bare}/insurance/experience`);
    const bucket = (res.json().byCurrency as { lossRatioPct: number | null; reasons: string[] }[])[0]!;
    expect(bucket.lossRatioPct).toBeNull();
    expect(bucket.reasons.join(" ")).toMatch(/No premium is recorded/i);
  });

  it("keeps a read-only member from recording premium", async () => {
    const res = await post(
      `/projects/${expProject}/insurance/policies/${expPolicy}/premiums`,
      { amount: 1 },
      viewerHeaders,
    );
    expect(res.statusCode).toBe(403);
  });
});

describe("renewal pipeline (#775)", () => {
  let renProject: string;
  let renPolicy: string;

  it("lists a policy whose renewal is behind its lead time", async () => {
    renProject = await makeProject("Renewals");
    renPolicy = await activePolicy(renProject, {
      policyNumber: "CAR/RENEW",
      periodStart: daysFromToday(-350),
      periodEnd: daysFromToday(10),
    });
    const res = await get(`/projects/${renProject}/insurance/renewals?leadTimeDays=30`);
    expect(res.statusCode).toBe(200);
    const row = (res.json().items as { policyId: string; urgency: string; behindByDays: number }[]).find(
      (r) => r.policyId === renPolicy,
    )!;
    expect(row.urgency).toBe("critical");
    expect(row.behindByDays).toBe(20);
  });

  it("moves the policy along the pipeline and refuses 'bound' with no successor", async () => {
    const noSuccessor = await post(
      `/projects/${renProject}/insurance/policies/${renPolicy}/renewal`,
      { renewalStatus: "bound" },
    );
    expect(noSuccessor.statusCode).toBe(400);
    expect(noSuccessor.json().message).toMatch(/successor/i);

    const instructed = await post(
      `/projects/${renProject}/insurance/policies/${renPolicy}/renewal`,
      { renewalStatus: "instructed", renewalTargetDate: daysFromToday(5) },
    );
    expect(instructed.statusCode).toBe(200);
    expect(instructed.json().renewalStatus).toBe("instructed");

    const next = await activePolicy(renProject, {
      policyNumber: "CAR/RENEW-2",
      periodStart: daysFromToday(11),
      periodEnd: daysFromToday(370),
    });
    const bound = await post(
      `/projects/${renProject}/insurance/policies/${renPolicy}/renewal`,
      { renewalStatus: "bound", renewedByPolicyId: next },
    );
    expect(bound.statusCode).toBe(200);

    const after = await get(`/projects/${renProject}/insurance/renewals`);
    expect(
      (after.json().items as { policyId: string }[]).some((r) => r.policyId === renPolicy),
    ).toBe(false);
  });

  it("raises policy_renewal_overdue once for an unrenewed policy past its lead time", async () => {
    const late = await activePolicy(renProject, {
      policyNumber: "CAR/LATE",
      periodStart: daysFromToday(-360),
      periodEnd: daysFromToday(3),
    });
    await runSweep(renProject);
    const key = `${late}:${daysFromToday(3)}`;
    expect(await signalsFor("policy_renewal_overdue", key)).toHaveLength(1);
    await runSweep(renProject);
    expect(await signalsFor("policy_renewal_overdue", key)).toHaveLength(1);
  });
});

describe("uninsured loss candidates (#787)", () => {
  it("flags an insured loss for which nobody raised a claim", async () => {
    const lossProject = await makeProject("Uninsured losses");
    await activePolicy(lossProject, {
      policyType: "third_party_liability",
      policyNumber: "TPL/LOSS",
      deductible: 5_000,
      periodStart: daysFromToday(-100),
      periodEnd: daysFromToday(200),
    });
    const incidentId = newId("inc");
    await app.db.insert(safetyIncidents).values({
      id: incidentId,
      companyId: owner.companyId,
      projectId: lossProject,
      number: 1,
      reference: "INC-0001",
      incidentType: "public_impact",
      severity: "serious",
      title: "Falling debris damaged a neighbouring roof",
      description: "Debris from level 6 struck the adjoining property",
      occurredAt: new Date(Date.now() - 5 * 86_400_000).toISOString(),
      estimatedCost: 120_000,
      createdBy: owner.userId,
    });
    await runSweep(lossProject);
    const raised = await signalsFor("uninsured_loss_candidate", `safety_incident:${incidentId}`);
    expect(raised).toHaveLength(1);
    expect(raised[0]!.explanation).toMatch(/condition/i);
    expect(raised[0]!.severity).toBe("high");

    await runSweep(lossProject);
    expect(
      await signalsFor("uninsured_loss_candidate", `safety_incident:${incidentId}`),
    ).toHaveLength(1);
  });
});

describe("the payment hold hook WP-FIN2 calls", () => {
  let holdProject: string;

  it("refuses to answer, rather than clearing the vendor, with no requirement recorded", async () => {
    holdProject = await makeProject("Payment holds");
    const res = await get(
      `/projects/${holdProject}/insurance/hold-check?vendorId=${vendorId}`,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().hold).toBe(false);
    expect(res.json().requirementsKnown).toBe(false);
    expect(res.json().note).toMatch(/NOT a statement that the vendor is compliant/i);
  });

  it("holds when no certificate exists and releases once in-date cover is evidenced", async () => {
    await post(`/projects/${holdProject}/insurance/requirements`, {
      policyType: "employers_liability",
      requiredByClause: "Subcontract cl.19",
      minimumLimit: 5_000_000,
      currency: "GBP",
    });
    const held = await get(
      `/projects/${holdProject}/insurance/hold-check?vendorId=${vendorId}`,
    );
    expect(held.json().hold).toBe(true);
    expect(held.json().findings[0].reason).toBe("no_certificate");

    const cert = await post(`/projects/${holdProject}/insurance/certificates`, {
      vendorId,
      subjectName: "Groundworks Ltd",
      policyType: "employers_liability",
      limitOfIndemnity: 10_000_000,
      currency: "GBP",
      validFrom: daysFromToday(-10),
      validTo: daysFromToday(200),
    });
    expect(cert.statusCode).toBe(201);
    const released = await get(
      `/projects/${holdProject}/insurance/hold-check?vendorId=${vendorId}`,
    );
    expect(released.json().hold).toBe(false);
    // unverified is a warning, never a hold: the failure is on our side
    expect((released.json().warnings as { reason: string }[]).map((w) => w.reason)).toContain(
      "certificate_unverified",
    );
  });

  it("holds on a limit below the requirement", async () => {
    const shortProject = await makeProject("Short limit");
    await post(`/projects/${shortProject}/insurance/requirements`, {
      policyType: "third_party_liability",
      requiredByClause: "Subcontract cl.20",
      minimumLimit: 10_000_000,
      currency: "GBP",
      vendorId: otherVendorId,
    });
    await post(`/projects/${shortProject}/insurance/certificates`, {
      vendorId: otherVendorId,
      subjectName: "Steelwork Ltd",
      policyType: "third_party_liability",
      limitOfIndemnity: 1_000_000,
      currency: "GBP",
      validFrom: daysFromToday(-5),
      validTo: daysFromToday(200),
    });
    const res = await get(
      `/projects/${shortProject}/insurance/hold-check?vendorId=${otherVendorId}`,
    );
    expect(res.json().hold).toBe(true);
    expect(res.json().findings[0].reason).toBe("limit_below_requirement");
  });

  it("records the company-level hold check as an access event in the ledger", async () => {
    const res = await get(`/insurance/hold-check?vendorId=${vendorId}`);
    expect(res.statusCode).toBe(200);
    const ledger = await get("/ledger?objectType=insurance_hold_check&pageSize=20");
    expect((ledger.json().items as { action: string }[]).some((e) => e.action === "access")).toBe(
      true,
    );
  });
});

describe("health inputs for the intelligence layer", () => {
  it("reports null rather than 0 for cover gaps where no requirement is recorded", async () => {
    const bare = await makeProject("Health inputs — bare");
    const res = await get(`/projects/${bare}/insurance/health-inputs`);
    expect(res.statusCode).toBe(200);
    expect(res.json().metrics.coverGaps).toBeNull();
    expect((res.json().reasons as string[]).join(" ")).toMatch(/reported as null rather than 0/i);
  });

  it("counts policies, certificates, claims and open insurance signals", async () => {
    const res = await get(`/projects/${gapProject}/insurance/health-inputs`);
    expect(res.statusCode).toBe(200);
    const m = res.json().metrics;
    expect(m.policies).toBeGreaterThan(0);
    expect(typeof m.certificatesUnverified).toBe("number");
    expect(typeof m.openInsuranceSignals).toBe("number");
    expect(m.coverGaps).not.toBeNull();
  });
});

describe("audit bug fixes", () => {
  it("[#10] rejects an unparseable or future verification date with 400, never a 500", async () => {
    const certProject = await makeProject("Verify dates");
    const created = await post(`/projects/${certProject}/insurance/certificates`, {
      vendorId,
      subjectName: "Groundworks Ltd",
      policyType: "third_party_liability",
      validFrom: daysFromToday(-5),
      validTo: daysFromToday(200),
    });
    expect(created.statusCode).toBe(201);
    const certId = created.json().id as string;

    for (const bad of ["abcd", "2026-13-45"]) {
      const res = await post(
        `/projects/${certProject}/insurance/certificates/${certId}/verify`,
        { verificationMethod: "broker_confirmation", verifiedAt: bad },
        verifier.headers,
      );
      expect(res.statusCode).toBe(400);
    }
    const future = await post(
      `/projects/${certProject}/insurance/certificates/${certId}/verify`,
      { verificationMethod: "broker_confirmation", verifiedAt: daysFromToday(30) },
      verifier.headers,
    );
    expect(future.statusCode).toBe(400);

    const ok = await post(
      `/projects/${certProject}/insurance/certificates/${certId}/verify`,
      { verificationMethod: "broker_confirmation", verifiedAt: daysFromToday(-1) },
      verifier.headers,
    );
    expect(ok.statusCode).toBe(200);
  });

  it("[#18] refuses to release a called bond with an outstanding demand, or an expired one", async () => {
    const relProject = await makeProject("Bond release states");
    const created = await post(`/projects/${relProject}/insurance/bonds`, {
      bondType: "performance",
      guarantor: "Surety Co",
      amount: 400_000,
      currency: "GBP",
      issuedAt: daysFromToday(-30),
      expiryAt: daysFromToday(300),
      demandDeadline: daysFromToday(200),
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    await post(`/projects/${relProject}/insurance/bonds/${id}/status`, { status: "active" });
    const called = await post(`/projects/${relProject}/insurance/bonds/${id}/call`, {
      amount: 100_000,
      reason: "Failure to complete the remedial works within the period stated in the notice",
    });
    expect(called.statusCode).toBe(201);
    const callId = called.json().id as string;

    const blocked = await post(`/projects/${relProject}/insurance/bonds/${id}/release`, {});
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().message).toMatch(/still outstanding/i);

    await post(`/projects/${relProject}/insurance/bond-calls/${callId}/outcome`, {
      outcome: "paid",
      proceedsAmount: 100_000,
    });
    const allowed = await post(`/projects/${relProject}/insurance/bonds/${id}/release`, {});
    expect(allowed.statusCode).toBe(200);

    const expiredId = newId("bnd");
    await app.db.insert(bonds).values({
      id: expiredId,
      companyId: owner.companyId,
      projectId: relProject,
      number: "BND-EXP",
      bondType: "performance",
      guarantor: "Surety Co",
      amount: 100_000,
      currency: "GBP",
      status: "expired",
      expiryAt: daysFromToday(-10),
      createdBy: owner.userId,
    });
    const expiredRelease = await post(
      `/projects/${relProject}/insurance/bonds/${expiredId}/release`,
      {},
    );
    expect(expiredRelease.statusCode).toBe(409);
    expect(expiredRelease.json().message).toMatch(/not released/i);
  });

  it("[#19] refuses another tenant's vendor as a broker on a company policy", async () => {
    const created = await post("/insurance/policies", policyPayload({ policyNumber: "CPOL/BROKER" }));
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    const foreignVendor = newId("ven");
    await app.db.insert(vendors).values({
      id: foreignVendor,
      companyId: stranger.companyId,
      name: "Foreign Broker",
    });
    const res = await patch(`/insurance/policies/${id}`, { brokerVendorId: foreignVendor });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/company directory/i);
  });

  it("[#20] does not return another project's claims through a company-level policy", async () => {
    const a = await makeProject("OCIP project A");
    const b = await makeProject("OCIP project B");
    const master = await post(
      "/insurance/policies",
      policyPayload({ policyType: "contractors_all_risks", policyNumber: "OCIP/1" }),
    );
    expect(master.statusCode).toBe(201);
    const masterId = master.json().id as string;
    await post(`/insurance/policies/${masterId}/status`, { status: "active" });

    const claimB = await post(`/projects/${b}/insurance/claims`, {
      policyId: masterId,
      title: "Confidential loss on project B",
      incidentDate: daysFromToday(-3),
      awareDate: daysFromToday(-2),
      reserve: 500_000,
    });
    expect(claimB.statusCode).toBe(201);

    const seenFromA = await get(`/projects/${a}/insurance/policies/${masterId}`);
    expect(seenFromA.statusCode).toBe(200);
    expect(seenFromA.json().claims).toEqual([]);
    expect(seenFromA.json().claimsScope).toBe("this_project_only");

    const seenFromB = await get(`/projects/${b}/insurance/policies/${masterId}`);
    expect((seenFromB.json().claims as unknown[]).length).toBe(1);
  });

  it("[#6] keeps an ordinary member out of the company-level policy programme", async () => {
    const create = await post("/insurance/policies", policyPayload(), viewerHeaders);
    expect(create.statusCode).toBe(403);
    const sweep = await post("/insurance/sweep", {}, viewerHeaders);
    expect(sweep.statusCode).toBe(403);
  });

  it("[#5/#27] restricts the company-level reads to the caller's own projects", async () => {
    // `viewer` is a read-only member of permProject only.
    const list = await get("/insurance/policies", viewerHeaders);
    expect(list.statusCode).toBe(200);
    const projectIds = (list.json().items as { projectId: string | null }[])
      .map((p) => p.projectId)
      .filter((id): id is string => id !== null);
    expect(projectIds.every((id) => id === permProject)).toBe(true);
    expect(projectIds).not.toContain(mainProject);

    const summary = await get("/insurance/summary", viewerHeaders);
    expect(summary.statusCode).toBe(200);
    expect(summary.json().visibility.all).toBe(false);

    const expiring = await get("/insurance/expiring?days=400", viewerHeaders);
    expect(expiring.statusCode).toBe(200);
    expect(expiring.json().visibility.all).toBe(false);

    // and the whole tenant for an owner
    const ownerList = await get("/insurance/policies");
    const ownerProjects = new Set(
      (ownerList.json().items as { projectId: string | null }[]).map((p) => p.projectId),
    );
    expect(ownerProjects.size).toBeGreaterThan(1);
  });

  it("[#9] does not write signals, statuses or ledger entries on a read", async () => {
    const readProject = await makeProject("Pure reads");
    const id = newId("pol");
    await app.db.insert(insurancePolicies).values({
      id,
      companyId: owner.companyId,
      projectId: readProject,
      number: "POL-PURE",
      policyType: "contractors_all_risks",
      insurer: "Acme Re",
      policyNumber: "CAR/PURE",
      periodStart: daysFromToday(-400),
      periodEnd: daysFromToday(-2),
      status: "active",
      createdBy: owner.userId,
    });
    for (const url of [
      `/projects/${readProject}/insurance/policies`,
      `/projects/${readProject}/insurance/policies/${id}`,
      `/projects/${readProject}/insurance/certificates`,
      `/projects/${readProject}/insurance/bonds`,
      `/projects/${readProject}/insurance/claims`,
      `/projects/${readProject}/insurance/summary`,
      `/projects/${readProject}/insurance/expiring`,
    ]) {
      const res = await get(url);
      expect(res.statusCode).toBe(200);
    }
    const [after] = await app.db
      .select()
      .from(insurancePolicies)
      .where(eq(insurancePolicies.id, id));
    expect(after?.status).toBe("active");
    expect(await signalsFor("policy_lapsed_during_works", id)).toHaveLength(0);

    // the scheduled job, under the system actor, is what actually sweeps it
    await app.scheduler.runNow("insurance.expiry");
    const [swept] = await app.db
      .select()
      .from(insurancePolicies)
      .where(eq(insurancePolicies.id, id));
    expect(swept?.status).toBe("expired");
    const raised = await signalsFor("policy_lapsed_during_works", id);
    expect(raised).toHaveLength(1);
  });

  it("[#8] evaluates each project against its own requirement set in company scope", async () => {
    const a = await makeProject("Scoped requirements A");
    const b = await makeProject("Scoped requirements B");
    const vA = newId("ven");
    const vB = newId("ven");
    await app.db.insert(vendors).values([
      { id: vA, companyId: owner.companyId, name: "Vendor A" },
      { id: vB, companyId: owner.companyId, name: "Vendor B" },
    ]);
    await app.db.insert(workers).values([
      {
        id: newId("wkr"),
        companyId: owner.companyId,
        projectId: a,
        reference: "W-A",
        fullName: "Worker A",
        vendorId: vA,
        status: "active",
        createdBy: owner.userId,
      },
      {
        id: newId("wkr"),
        companyId: owner.companyId,
        projectId: b,
        reference: "W-B",
        fullName: "Worker B",
        vendorId: vB,
        status: "active",
        createdBy: owner.userId,
      },
    ]);
    await post(`/projects/${a}/insurance/requirements`, {
      policyType: "decennial",
      requiredByClause: "Project A special condition",
    });
    await app.scheduler.runNow("insurance.expiry");
    expect(await signalsFor("insurance_cover_gap", `${a}:${vA}:decennial`)).toHaveLength(1);
    expect(await signalsFor("insurance_cover_gap", `${b}:${vB}:decennial`)).toHaveLength(0);
  });

  it("warns before a claim's notification deadline rather than only after it", async () => {
    const warnProject = await makeProject("Notification warnings");
    const pol = await activePolicy(warnProject, {
      policyNumber: "CAR/WARN",
      notificationDays: 30,
    });
    const claim = await post(`/projects/${warnProject}/insurance/claims`, {
      policyId: pol,
      title: "Water ingress",
      incidentDate: daysFromToday(-25),
      awareDate: daysFromToday(-24),
      reserve: 25_000,
    });
    expect(claim.statusCode).toBe(201);
    const claimId = claim.json().id as string;

    await app.scheduler.runNow("insurance.claim-notification-warnings");
    const warned = await signalsFor("insurance_notification_missed", `${claimId}:warn`);
    expect(warned).toHaveLength(1);
    expect(warned[0]!.explanation).toMatch(/BEFORE the date/);

    await app.scheduler.runNow("insurance.claim-notification-warnings");
    expect(await signalsFor("insurance_notification_missed", `${claimId}:warn`)).toHaveLength(1);
  });
});
