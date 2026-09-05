/**
 * Progress determination — the Assertion / Evidence / Reconciliation triple,
 * the different-actor rule, and the workspace summary and health inputs.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  assertions,
  companyMemberships,
  evidence,
  projectMemberships,
  projects,
  reconciliations,
  signals,
  vendors,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import { siteModule } from "./index.js";

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
let claimant: TestActor;
let viewerHeaders: Record<string, string>;
let stranger: TestActor;
let projectId: string;
let vendorId: string;

function post(url: string, payload: unknown, headers = owner.headers) {
  return app.inject({ method: "POST", url: `/api/v1${url}`, headers, payload });
}
function get(url: string, headers = owner.headers) {
  return app.inject({ method: "GET", url: `/api/v1${url}`, headers });
}

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  if (!app.scheduler.has("site.lone-worker")) await app.register(siteModule, { prefix: "/api/v1" });
  owner = await registerActor(app);

  claimant = await registerActor(app);
  await app.db.insert(companyMemberships).values({ id: newId("cm"), companyId: owner.companyId, userId: claimant.userId, role: "member" });
  claimant = { ...claimant, companyId: owner.companyId, headers: { authorization: claimant.headers["authorization"]!, "x-company-id": owner.companyId } };

  const viewer = await registerActor(app);
  await app.db.insert(companyMemberships).values({ id: newId("cm"), companyId: owner.companyId, userId: viewer.userId, role: "member" });
  viewerHeaders = { authorization: viewer.headers["authorization"]!, "x-company-id": owner.companyId };

  stranger = await registerActor(app);

  projectId = newId("prj");
  await app.db.insert(projects).values({ id: projectId, companyId: owner.companyId, name: "Site — progress", stage: "course_of_construction" });
  await app.db.insert(projectMemberships).values({ id: newId("pm"), companyId: owner.companyId, projectId, userId: viewer.userId, templateKey: "read_only" });

  vendorId = newId("ven");
  await app.db.insert(vendors).values({ id: vendorId, companyId: owner.companyId, name: "Frame Co", country: "GB" });
});

afterAll(async () => {
  await built.close();
});

const base = () => `/projects/${projectId}/site`;

describe("the different-actor rule", () => {
  it("refuses an observation authored by the claimant", async () => {
    const res = await post(`${base()}/progress-observations`, {
      zoneName: "Level 3 slab",
      claimedPercent: 80,
      observedPercent: 80,
      claimantId: owner.userId,
      method: "photo",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("same actor");
  });
});

describe("recording an observation", () => {
  let observationId: string;

  it("writes the assertion, the evidence and the reconciliation", async () => {
    const res = await post(`${base()}/progress-observations`, {
      zoneName: "Level 3 slab",
      workPackageRef: "WP-03",
      claimedPercent: 80,
      observedPercent: 78,
      method: "photo",
      claimSourceType: "valuation",
      claimSourceId: "val_123",
      claimantId: claimant.userId,
      claimantVendorId: vendorId,
      fileIds: ["file_a", "file_b"],
    });
    expect(res.statusCode).toBe(201);
    observationId = res.json().id;
    expect(res.json().reference).toMatch(/^PRG-\d{3}$/);
    expect(res.json().result).toBe("supported");
    expect(res.json().assessment.variancePercent).toBe(2);
    expect(res.json().signalId).toBeNull();

    const [assertion] = await app.db.select().from(assertions).where(eq(assertions.id, res.json().assertionId));
    expect(assertion?.kind).toBe("progress_percent");
    expect(assertion?.value).toBe(80);
    expect(assertion?.claimantId).toBe(claimant.userId);

    const [ev] = await app.db.select().from(evidence).where(eq(evidence.id, res.json().evidenceId));
    expect(ev?.kind).toBe("photograph");
    expect(ev?.submittedBy).toBe(owner.userId);
    expect(ev?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(ev?.independenceScore).toBeGreaterThan(0);

    const [rec] = await app.db.select().from(reconciliations).where(eq(reconciliations.id, res.json().reconciliationId));
    expect(rec?.result).toBe("supported");
    expect(rec?.evidenceIds).toEqual([res.json().evidenceId]);
  });

  it("returns the whole triple on the detail view", async () => {
    const res = await get(`${base()}/progress-observations/${observationId}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().assertion.value).toBe(80);
    expect(res.json().evidence.metadata.observedPercent).toBe(78);
    expect(res.json().reconciliation.method).toBe("progress_photo");
  });

  it("raises a signal on a material overclaim, with severity tracking the gap", async () => {
    const res = await post(`${base()}/progress-observations`, {
      zoneName: "Level 4 cladding",
      claimedPercent: 90,
      observedPercent: 40,
      method: "drone",
      claimantId: claimant.userId,
      claimSourceType: "progress_claim",
      droneFlightId: "uav_x",
      fileIds: ["file_c"],
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().result).toBe("unsupported");
    expect(res.json().assessment.variancePercent).toBe(50);
    expect(res.json().signalId).toBeTruthy();
    const raised = await app.db
      .select()
      .from(signals)
      .where(and(eq(signals.companyId, owner.companyId), eq(signals.detector, "site_progress_overclaim")));
    expect(raised).toHaveLength(1);
    expect(raised[0]?.severity).toBe("critical");
    expect(raised[0]?.explanation).toContain("independence");
  });

  it("calls a claim with nothing built contradicted", async () => {
    const res = await post(`${base()}/progress-observations`, {
      zoneName: "Level 5 blockwork",
      claimedPercent: 60,
      observedPercent: 0,
      method: "scan",
      claimantId: claimant.userId,
      scanId: "scn_x",
      fileIds: ["file_d"],
    });
    expect(res.json().result).toBe("contradicted");
  });

  it("records insufficient_evidence rather than a verdict when the observation is too weak", async () => {
    const res = await post(`${base()}/progress-observations`, {
      zoneName: "Level 6 finishes",
      claimedPercent: 95,
      observedPercent: 10,
      method: "visual",
      claimantId: claimant.userId,
      claimantVendorId: vendorId,
      observerVendorId: vendorId,
      fileIds: [],
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().result).toBe("insufficient_evidence");
    expect(res.json().assessment.reasons.join(" ")).toContain("below the 0.35");
    expect(res.json().signalId).toBeNull();
  });

  it("filters the register by result", async () => {
    const res = await get(`${base()}/progress-observations?result=unsupported`);
    expect(res.json().total).toBe(1);
    expect(res.json().byResult).toEqual({ unsupported: 1 });
    const contradicted = await get(`${base()}/progress-observations?result=contradicted`);
    expect(contradicted.json().total).toBe(1);
  });

  it("refuses a schedule task from another project", async () => {
    const res = await post(`${base()}/progress-observations`, {
      zoneName: "Nowhere",
      claimedPercent: 10,
      observedPercent: 10,
      claimantId: claimant.userId,
      scheduleTaskId: "tsk_nope",
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("summary and health inputs", () => {
  it("summarises the workspace and says why the headcount is unknown", async () => {
    const res = await get(`${base()}/summary`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.progress.observations).toBe(4);
    expect(body.progress.overclaims).toBe(2);
    expect(body.progress.worstVariance.value).toBe(60);
    expect(body.register.headcount).toBe(0);
    expect(body.register.reasons[0]).toContain("gate feed is not connected");
    expect(body.signals.open).toBeGreaterThan(0);
  });

  it("gives the intelligence layer null (not zero) where it holds nothing", async () => {
    const res = await get(`${base()}/health-inputs`);
    expect(res.statusCode).toBe(200);
    expect(res.json().metrics.siteHeadcount).toBeNull();
    expect(res.json().metrics.siteProgressOverclaims).toBe(2);
    expect(res.json().metrics.siteWorstProgressVariance).toBe(60);
    expect(res.json().metrics.siteExceptionalWeatherDays).toBeNull();
    expect(res.json().reasons.join(" ")).toContain("no gate feed");
  });

  it("lists this module's signals and nobody else's", async () => {
    const res = await get(`${base()}/signals`);
    expect(res.statusCode).toBe(200);
    expect(res.json().items.every((s: { detector: string }) => s.detector.startsWith("site_"))).toBe(true);

    // A detector from another module is never returned, even when asked for
    // by name: `site_ops` read access is not read access to every detector.
    await app.db.insert(signals).values({
      id: newId("sig"),
      companyId: owner.companyId,
      projectId,
      detector: "ghost_vendor_shared_bank_account",
      severity: "high",
      confidence: 0.9,
      title: "Not a site signal",
      explanation: "Raised by the assurance layer.",
    });
    const asked = await get(`${base()}/signals?detector=ghost_vendor_shared_bank_account`);
    expect(asked.statusCode).toBe(200);
    expect(asked.json().total).toBe(0);
  });

  it("runs every sweep from one endpoint", async () => {
    const res = await post(`${base()}/sweeps/run`, {});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty("permits");
    expect(res.json()).toHaveProperty("loneWorkers");
    expect(res.json()).toHaveProperty("overstays");
  });
});

describe("tenant isolation", () => {
  it("refuses another company", async () => {
    expect((await get(`${base()}/progress-observations`, stranger.headers)).statusCode).toBe(403);
    expect((await get(`${base()}/summary`, stranger.headers)).statusCode).toBe(403);
    expect((await get(`${base()}/health-inputs`, stranger.headers)).statusCode).toBe(403);
    expect(
      (await post(`${base()}/progress-observations`, { zoneName: "x", claimedPercent: 1, observedPercent: 1, claimantId: "u" }, stranger.headers)).statusCode,
    ).toBe(403);
  });

  it("keeps the sweep endpoint to admins", async () => {
    expect((await post(`${base()}/sweeps/run`, {}, viewerHeaders)).statusCode).toBe(403);
    expect((await get(`${base()}/summary`, viewerHeaders)).statusCode).toBe(200);
  });
});
