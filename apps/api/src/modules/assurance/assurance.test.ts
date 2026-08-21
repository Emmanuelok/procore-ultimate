import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import {
  assuranceGrants,
  companyMemberships,
  ledgerEntries,
  projects,
  reconciliations,
  signals,
  workflowInstances,
  workflowStepInstances,
} from "@constructos/db";
import { verifyMerkleProof } from "@constructos/ledger";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";
import {
  benfordFirstDigit,
  duplicateAssertions,
  roundNumberClustering,
} from "./detectors.js";

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor; // company owner (operational actor / claimant)
let reviewer: TestActor; // second user, joined into owner's company as admin
let projectId: string;

/** headers for `reviewer` acting inside owner's company */
let reviewerHeaders: Record<string, string>;

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  owner = await registerActor(app);
  reviewer = await registerActor(app);
  // put reviewer into owner's company as an admin (tool bypass, but NOT an assurance role)
  await app.db.insert(companyMemberships).values({
    id: newId("cm"),
    companyId: owner.companyId,
    userId: reviewer.userId,
    role: "admin",
  });
  reviewerHeaders = {
    authorization: reviewer.headers["authorization"]!,
    "x-company-id": owner.companyId,
  };
  projectId = newId("prj");
  await app.db.insert(projects).values({
    id: projectId,
    companyId: owner.companyId,
    name: "P1",
  });
});

afterAll(async () => {
  await built.close();
});

/* ------------------------------------------------------------------ */
/* Pure detector unit tests                                            */
/* ------------------------------------------------------------------ */

describe("benford_first_digit (pure)", () => {
  it("fires on fabricated uniform-first-digit data", () => {
    const values: number[] = [];
    for (let d = 1; d <= 9; d++) {
      for (let k = 0; k < 10; k++) values.push(d * 100 + k * 7);
    }
    const res = benfordFirstDigit(values);
    expect(res.skipped).toBe(false);
    expect(res.chiSquare).toBeGreaterThan(30);
    expect(res.draft).not.toBeNull();
    expect(res.draft!.severity).toBe("high");
    expect(res.draft!.explanation).toContain("histogram");
  });

  it("does not fire on log-uniform natural data", () => {
    const values: number[] = [];
    const n = 200;
    for (let i = 0; i < n; i++) values.push(Math.pow(10, (i / n) * 3));
    const res = benfordFirstDigit(values);
    expect(res.skipped).toBe(false);
    expect(res.chiSquare).toBeLessThan(20);
    expect(res.draft).toBeNull();
  });

  it("skips below n=30", () => {
    const res = benfordFirstDigit([100, 200, 300]);
    expect(res.skipped).toBe(true);
    expect(res.draft).toBeNull();
  });
});

describe("other pure detectors", () => {
  it("duplicate_assertions flags same kind+value+unit+claimant within 30 days", () => {
    const drafts = duplicateAssertions([
      {
        id: "a1",
        kind: "quantity",
        value: 42,
        unit: "m3",
        claimantId: "u1",
        assertedAt: "2026-08-01T00:00:00Z",
      },
      {
        id: "a2",
        kind: "quantity",
        value: 42,
        unit: "m3",
        claimantId: "u1",
        assertedAt: "2026-08-10T00:00:00Z",
      },
      // different claimant → no signal
      {
        id: "a3",
        kind: "quantity",
        value: 42,
        unit: "m3",
        claimantId: "u2",
        assertedAt: "2026-08-10T00:00:00Z",
      },
    ]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.severity).toBe("medium");
  });

  it("round_number_clustering fires above 40% round share", () => {
    const values = [100, 200, 300, 400, 500, 600, 101, 202, 303, 404, 505, 606];
    const draft = roundNumberClustering(values);
    expect(draft).not.toBeNull();
    expect(draft!.severity).toBe("medium");
    expect(roundNumberClustering([101, 203, 307, 401, 503, 607, 701, 803, 907, 1009])).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Assertions + evidence + reconciliation (separation rule, bands)     */
/* ------------------------------------------------------------------ */

async function createAssertion(value: number | null, kind = "cost", extra: object = {}) {
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/assertions`,
    headers: owner.headers,
    payload: { kind, value, unit: "usd", basis: "monthly claim", ...extra },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; claimantId: string };
}

async function createEvidence(
  headers: Record<string, string>,
  metadata: Record<string, unknown>,
  independenceScore = 0.8,
) {
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/evidence`,
    headers,
    payload: {
      kind: "survey",
      source: "independent surveyor",
      independenceScore,
      metadata,
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; contentHash: string; submittedBy: string };
}

describe("reconciliations", () => {
  it("blocks a reconciliation where all evidence comes from the claimant (separation rule)", async () => {
    const assertion = await createAssertion(100);
    const selfEvidence = await createEvidence(owner.headers, { value: 100 });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/reconciliations`,
      headers: owner.headers,
      payload: {
        assertionId: assertion.id,
        evidenceIds: [selfEvidence.id],
        method: "quantity_check",
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toContain("not independent");

    // grant integrity_reviewer to the caller → override allowed
    await app.db.insert(assuranceGrants).values({
      id: newId("ag"),
      companyId: owner.companyId,
      projectId: null,
      userId: owner.userId,
      role: "integrity_reviewer",
      grantedBy: owner.userId,
    });
    const res2 = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/reconciliations`,
      headers: owner.headers,
      payload: {
        assertionId: assertion.id,
        evidenceIds: [selfEvidence.id],
        method: "quantity_check",
      },
    });
    expect(res2.statusCode).toBe(201);
    // remove the grant so later tests see the un-privileged owner
    await app.db.delete(assuranceGrants).where(eq(assuranceGrants.userId, owner.userId));
  });

  it("computes auto result bands from numeric evidence", async () => {
    const cases: { evValue: number; expected: string; vp: number }[] = [
      { evValue: 103, expected: "supported", vp: 3 },
      { evValue: 110, expected: "partially_supported", vp: 10 },
      { evValue: 130, expected: "contradicted", vp: 30 },
      { evValue: 70, expected: "contradicted", vp: -30 }, // sign-agnostic
    ];
    for (const c of cases) {
      const assertion = await createAssertion(100);
      const ev = await createEvidence(reviewerHeaders, { value: c.evValue }, 0.9);
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${projectId}/reconciliations`,
        headers: owner.headers,
        payload: { assertionId: assertion.id, evidenceIds: [ev.id], method: "survey_compare" },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as {
        result: string;
        variancePercent: number;
        confidence: number;
      };
      expect(body.result).toBe(c.expected);
      expect(body.variancePercent).toBeCloseTo(c.vp, 5);
      expect(body.confidence).toBeCloseTo(0.9, 5);
    }
  });

  it("returns insufficient_evidence without numerics, and requires result for manual", async () => {
    const assertion = await createAssertion(100);
    const ev = await createEvidence(reviewerHeaders, { note: "photo only" });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/reconciliations`,
      headers: owner.headers,
      payload: { assertionId: assertion.id, evidenceIds: [ev.id], method: "visual" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().result).toBe("insufficient_evidence");

    const manualMissing = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/reconciliations`,
      headers: owner.headers,
      payload: { assertionId: assertion.id, evidenceIds: [ev.id], method: "manual" },
    });
    expect(manualMissing.statusCode).toBe(400);

    const manualOk = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/reconciliations`,
      headers: owner.headers,
      payload: {
        assertionId: assertion.id,
        evidenceIds: [ev.id],
        method: "manual",
        result: "supported",
      },
    });
    expect(manualOk.statusCode).toBe(201);
    expect(manualOk.json().result).toBe("supported");
  });
});

/* ------------------------------------------------------------------ */
/* Evidence immutability + multipart upload + packs                    */
/* ------------------------------------------------------------------ */

describe("evidence", () => {
  it("accepts a multipart upload and hashes the file", async () => {
    const boundary = "----vitestboundary";
    const fileBuffer = Buffer.from("evidence file body");
    const field = (name: string, value: string) =>
      Buffer.from(
        `--${boundary}\r\ncontent-disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      );
    const body = Buffer.concat([
      field("kind", "photograph"),
      field("source", "site drone"),
      field("independenceScore", "0.7"),
      field("metadata", JSON.stringify({ value: 12 })),
      Buffer.from(
        `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="x.jpg"\r\ncontent-type: image/jpeg\r\n\r\n`,
      ),
      fileBuffer,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/evidence`,
      headers: {
        ...owner.headers,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    const ev = res.json() as { contentHash: string; fileId: string; independenceScore: number };
    expect(ev.fileId).toBeTruthy();
    expect(ev.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(ev.independenceScore).toBeCloseTo(0.7);
  });

  it("has no update or delete routes (immutable)", async () => {
    const ev = await createEvidence(owner.headers, { value: 1 });
    for (const method of ["PATCH", "PUT", "DELETE"] as const) {
      const res = await app.inject({
        method,
        url: `/api/v1/projects/${projectId}/evidence/${ev.id}`,
        headers: owner.headers,
        payload: {},
      });
      expect([404, 405]).toContain(res.statusCode);
    }
  });

  it("builds a Merkle evidence pack with verifiable proofs", async () => {
    const ev1 = await createEvidence(owner.headers, { value: 1 });
    const ev2 = await createEvidence(owner.headers, { value: 2 });
    const ev3 = await createEvidence(owner.headers, { value: 3 });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/evidence-packs`,
      headers: owner.headers,
      payload: { evidenceIds: [ev1.id, ev2.id, ev3.id] },
    });
    expect(res.statusCode).toBe(201);
    const pack = res.json() as {
      root: string;
      items: { evidenceId: string; contentHash: string; proof: never }[];
    };
    expect(pack.items).toHaveLength(3);
    for (const item of pack.items) {
      expect(verifyMerkleProof(item.contentHash, item.proof, pack.root)).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Obligations                                                         */
/* ------------------------------------------------------------------ */

describe("obligations", () => {
  it("upcoming window returns due obligations and lazily breaches overdue ones", async () => {
    const past = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
    const soon = new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString();
    const far = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString();

    const mk = async (deadline: string) => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${projectId}/obligations`,
        headers: owner.headers,
        payload: {
          sourceClause: "20.1",
          trigger: "notice of claim",
          deadline,
          warnDaysBefore: 7,
        },
      });
      expect(res.statusCode).toBe(201);
      return res.json() as { id: string };
    };
    const overdue = await mk(past);
    const upcoming = await mk(soon);
    await mk(far);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/obligations/upcoming?days=30`,
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: { id: string }[]; breached: number };
    expect(body.breached).toBe(1);
    expect(body.items.map((i) => i.id)).toContain(upcoming.id);
    expect(body.items.map((i) => i.id)).not.toContain(overdue.id);

    const check = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/obligations/${overdue.id}`,
      headers: owner.headers,
    });
    expect(check.json().status).toBe("breached");
  });

  it("satisfy attaches evidence; waive records the reason in the ledger", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/obligations`,
      headers: owner.headers,
      payload: { sourceClause: "4.2", trigger: "insurance certificate" },
    });
    const obligation = res.json() as { id: string };
    const ev = await createEvidence(reviewerHeaders, { doc: "certificate" });
    const sat = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/obligations/${obligation.id}/satisfy`,
      headers: owner.headers,
      payload: { evidenceId: ev.id },
    });
    expect(sat.statusCode).toBe(200);
    expect(sat.json().status).toBe("satisfied");
    expect(sat.json().satisfiedEvidenceId).toBe(ev.id);

    const res2 = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/obligations`,
      headers: owner.headers,
      payload: { sourceClause: "9.9", trigger: "bond renewal" },
    });
    const waive = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/obligations/${res2.json().id}/waive`,
      headers: owner.headers,
      payload: { reason: "superseded by deed of variation" },
    });
    expect(waive.statusCode).toBe(200);
    expect(waive.json().status).toBe("waived");
  });
});

/* ------------------------------------------------------------------ */
/* Detector runs against DB                                            */
/* ------------------------------------------------------------------ */

describe("detectors/run", () => {
  it("creates signals for benford, duplicates, velocity, segregation and contradicted claimants", async () => {
    // fabricated uniform-first-digit cost population (fires benford)
    for (let d = 1; d <= 9; d++) {
      for (let k = 0; k < 10; k++) {
        await createAssertion(d * 100 + k * 7 + 1, "cost", { basis: `claim ${d}-${k}` });
      }
    }
    // duplicate pair (fires duplicate_assertions)
    await createAssertion(4242, "quantity", { unit: "m3" });
    await createAssertion(4242, "quantity", { unit: "m3" });

    // workflow rows: initiator approves own steps, all within 60s (fires both
    // segregation_of_duties and approval_velocity)
    const instId = newId("wfi");
    await app.db.insert(workflowInstances).values({
      id: instId,
      companyId: owner.companyId,
      projectId,
      templateId: newId("wft"),
      templateVersion: 1,
      recordType: "invoice",
      recordId: newId("inv"),
      status: "approved",
      startedBy: owner.userId,
    });
    const t0 = new Date("2026-08-01T10:00:00Z");
    for (let i = 0; i < 3; i++) {
      await app.db.insert(workflowStepInstances).values({
        id: newId("wfs"),
        instanceId: instId,
        position: i,
        name: `step ${i}`,
        stepType: "approval",
        assigneeId: owner.userId,
        decision: "approved",
        createdAt: new Date(t0.getTime() + i * 120_000).toISOString(),
        decidedAt: new Date(t0.getTime() + i * 120_000 + 10_000).toISOString(),
      });
    }

    // two contradicted reconciliations against the same claimant
    for (let i = 0; i < 2; i++) {
      const assertion = await createAssertion(100);
      await app.db.insert(reconciliations).values({
        id: newId("rec"),
        companyId: owner.companyId,
        projectId,
        assertionId: assertion.id,
        evidenceIds: [],
        method: "seed",
        result: "contradicted",
        createdBy: reviewer.userId,
      });
    }

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/detectors/run`,
      headers: owner.headers,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      created: number;
      skipped: string[];
      perDetector: Record<string, number>;
    };
    expect(body.perDetector["benford_first_digit"]).toBe(1);
    expect(body.perDetector["duplicate_assertions"]).toBeGreaterThanOrEqual(1);
    expect(body.perDetector["approval_velocity"]).toBe(1);
    expect(body.perDetector["segregation_of_duties"]).toBe(1);
    expect(body.perDetector["contradicted_claimant"]).toBe(1);
    expect(body.created).toBeGreaterThanOrEqual(5);

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/signals?pageSize=100`,
      headers: owner.headers,
    });
    expect(list.statusCode).toBe(200);
    const detectors = (list.json().items as { detector: string }[]).map((s) => s.detector);
    expect(detectors).toContain("benford_first_digit");
    expect(detectors).toContain("segregation_of_duties");
  });

  it("rejects unknown detector names", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/detectors/run`,
      headers: owner.headers,
      payload: { detectors: ["nonsense"] },
    });
    expect(res.statusCode).toBe(400);
  });
});

/* ------------------------------------------------------------------ */
/* Signals: segregation of duties on disposition                       */
/* ------------------------------------------------------------------ */

describe("signal disposition", () => {
  it("is forbidden without integrity_reviewer, allowed with the grant", async () => {
    await app.db.insert(signals).values({
      id: "sig_disposition_test",
      companyId: owner.companyId,
      projectId,
      detector: "manual_seed",
      severity: "medium",
      confidence: 0.5,
      title: "seed",
      explanation: "seed",
    });

    // owner (operational admin, no assurance role) must NOT disposition
    const denied = await app.inject({
      method: "PATCH",
      url: "/api/v1/signals/sig_disposition_test/disposition",
      headers: owner.headers,
      payload: { disposition: "confirmed" },
    });
    expect(denied.statusCode).toBe(403);

    // reviewer gains integrity_reviewer grant → allowed
    await app.db.insert(assuranceGrants).values({
      id: newId("ag"),
      companyId: owner.companyId,
      projectId: null,
      userId: reviewer.userId,
      role: "integrity_reviewer",
      grantedBy: owner.userId,
    });
    const allowed = await app.inject({
      method: "PATCH",
      url: "/api/v1/signals/sig_disposition_test/disposition",
      headers: reviewerHeaders,
      payload: { disposition: "confirmed", reviewerNotes: "verified on site" },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().disposition).toBe("confirmed");
    expect(allowed.json().reviewerId).toBe(reviewer.userId);

    const stats = await app.inject({
      method: "GET",
      url: "/api/v1/signals/stats",
      headers: owner.headers,
    });
    expect(stats.statusCode).toBe(200);
    expect(stats.json().byDisposition["confirmed"]).toBeGreaterThanOrEqual(1);
  });
});

/* ------------------------------------------------------------------ */
/* Entities: graph + shared identifier scan                            */
/* ------------------------------------------------------------------ */

describe("entities", () => {
  it("scan links entities sharing a bank account and raises a high signal", async () => {
    const mkEntity = async (name: string, identifiers: Record<string, string>) => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/entities",
        headers: owner.headers,
        payload: { kind: "company", name, identifiers },
      });
      expect(res.statusCode).toBe(201);
      return res.json() as { id: string };
    };
    const e1 = await mkEntity("Alpha Contracting", {
      bank_account: "GB29NWBK60161331926819",
      email: "office@alpha.example",
    });
    const e2 = await mkEntity("Beta Supplies", {
      bank_account: "gb29nwbk60161331926819",
      phone: "+44 20 1234 5678",
    });
    await mkEntity("Gamma Ltd", { bank_account: "GB00OTHER000000000000" });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/entities/scan",
      headers: owner.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      relationshipsCreated: number;
      signalsCreated: number;
      findings: { identifier: string; kind: string }[];
    };
    expect(body.relationshipsCreated).toBe(1);
    expect(body.signalsCreated).toBe(1);
    expect(body.findings[0]!.kind).toBe("shares_bank_account_with");

    // idempotent: second scan creates nothing new
    const res2 = await app.inject({
      method: "POST",
      url: "/api/v1/entities/scan",
      headers: owner.headers,
    });
    expect(res2.json().relationshipsCreated).toBe(0);

    const graph = await app.inject({
      method: "GET",
      url: `/api/v1/entities/${e1.id}/graph?depth=2`,
      headers: owner.headers,
    });
    expect(graph.statusCode).toBe(200);
    const g = graph.json() as { nodes: { id: string }[]; edges: unknown[] };
    expect(g.nodes.map((n) => n.id)).toContain(e2.id);
    expect(g.edges.length).toBeGreaterThanOrEqual(1);
  });
});

/* ------------------------------------------------------------------ */
/* Ledger integrity                                                    */
/* ------------------------------------------------------------------ */

describe("ledger", () => {
  it("verifies clean, then detects a corrupted entry", async () => {
    const ok = await app.inject({
      method: "GET",
      url: "/api/v1/ledger/verify",
      headers: owner.headers,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().valid).toBe(true);
    expect(ok.json().count).toBeGreaterThan(0);

    // object history endpoint
    const hist = await app.inject({
      method: "GET",
      url: "/api/v1/ledger?objectType=signal&objectId=sig_disposition_test",
      headers: owner.headers,
    });
    expect(hist.statusCode).toBe(200);
    expect(hist.json().total).toBeGreaterThanOrEqual(1);

    const recent = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/ledger/recent`,
      headers: owner.headers,
    });
    expect(recent.statusCode).toBe(200);
    expect(recent.json().items.length).toBeGreaterThan(0);

    // corrupt one row in the middle of the chain
    const rows = await app.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.companyId, owner.companyId));
    const victim = rows[Math.floor(rows.length / 2)]!;
    await app.db
      .update(ledgerEntries)
      .set({ payloadHash: "0".repeat(64) })
      .where(eq(ledgerEntries.seq, victim.seq));

    const broken = await app.inject({
      method: "GET",
      url: "/api/v1/ledger/verify",
      headers: owner.headers,
    });
    expect(broken.statusCode).toBe(200);
    expect(broken.json().valid).toBe(false);
  });
});
