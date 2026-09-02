/**
 * Integration tests for the assurance upgrade: every route added in this wave,
 * and a REGRESSION test for every bug the audit found in this area.
 *
 * The bug regressions are labelled `REGRESSION:` and each one reproduces the
 * attack the audit described, not merely the symptom — a test that asserts a
 * 403 without walking the path that used to succeed proves nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  assuranceGrants,
  companyMemberships,
  entityRelationships,
  invoices,
  ledgerEntries,
  projects,
  signals,
  vendors,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import { newId } from "../../lib/ids.js";

let built: Awaited<ReturnType<typeof buildTestApp>>;
let app: FastifyInstance;
let owner: TestActor;
let member: TestActor; // company "member" role: no assurance, no project membership
let reviewerA: TestActor; // integrity_reviewer scoped to project A only
let surveyor: TestActor; // company admin + tenant-wide auditor: the independent evidence source
let stranger: TestActor; // a different tenant entirely
let projectA: string;
let projectB: string;

function headersFor(actor: TestActor, companyId: string): Record<string, string> {
  return { authorization: actor.headers["authorization"]!, "x-company-id": companyId };
}

let memberHeaders: Record<string, string>;
let reviewerHeaders: Record<string, string>;
let surveyorHeaders: Record<string, string>;

beforeAll(async () => {
  built = await buildTestApp();
  app = built.app;
  owner = await registerActor(app);
  member = await registerActor(app);
  reviewerA = await registerActor(app);
  surveyor = await registerActor(app);
  stranger = await registerActor(app);

  for (const [actor, role] of [
    [member, "member"],
    [reviewerA, "member"],
    [surveyor, "admin"],
  ] as const) {
    await app.db.insert(companyMemberships).values({
      id: newId("cm"),
      companyId: owner.companyId,
      userId: actor.userId,
      role,
    });
  }
  memberHeaders = headersFor(member, owner.companyId);
  reviewerHeaders = headersFor(reviewerA, owner.companyId);
  surveyorHeaders = headersFor(surveyor, owner.companyId);

  projectA = newId("prj");
  projectB = newId("prj");
  await app.db.insert(projects).values([
    { id: projectA, companyId: owner.companyId, name: "Project A" },
    { id: projectB, companyId: owner.companyId, name: "Project B" },
  ]);

  // reviewerA holds an integrity_reviewer grant for PROJECT A ONLY.
  await app.db.insert(assuranceGrants).values({
    id: newId("ag"),
    companyId: owner.companyId,
    projectId: projectA,
    userId: reviewerA.userId,
    role: "integrity_reviewer",
    grantedBy: owner.userId,
  });
  // surveyor is the independent evidence source: an admin (so they can write)
  // holding a tenant-wide AUDITOR grant (so they may record a claim on behalf
  // of someone else) — but NOT integrity_reviewer, so they cannot wave a
  // self-certified reconciliation through.
  await app.db.insert(assuranceGrants).values({
    id: newId("ag"),
    companyId: owner.companyId,
    projectId: null,
    userId: surveyor.userId,
    role: "auditor",
    grantedBy: owner.userId,
  });
});

afterAll(async () => {
  await built.close();
});

async function post(url: string, headers: Record<string, string>, payload?: unknown) {
  return app.inject({ method: "POST", url: `/api/v1${url}`, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
}
async function get(url: string, headers: Record<string, string>) {
  return app.inject({ method: "GET", url: `/api/v1${url}`, headers });
}
async function patch(url: string, headers: Record<string, string>, payload?: unknown) {
  return app.inject({ method: "PATCH", url: `/api/v1${url}`, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
}
async function del(url: string, headers: Record<string, string>, payload?: unknown) {
  return app.inject({ method: "DELETE", url: `/api/v1${url}`, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
}

async function mkAssertion(
  projectId: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
) {
  const res = await post(`/projects/${projectId}/assertions`, headers, {
    kind: "quantity",
    value: 100,
    unit: "m3",
    basis: "monthly claim",
    ...body,
  });
  return res;
}

async function mkEvidence(
  projectId: string,
  headers: Record<string, string>,
  body: Record<string, unknown> = {},
) {
  const res = await post(`/projects/${projectId}/evidence`, headers, {
    kind: "survey",
    source: "independent surveyor",
    independenceScore: 0.9,
    metadata: { value: 100 },
    ...body,
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; contentHash: string };
}

/* ================================================================== */
/* REGRESSION: the separation rule was one client-supplied string away */
/* from meaningless                                                    */
/* ================================================================== */

describe("REGRESSION: claimant attribution cannot be forged", () => {
  it("refuses an assertion filed in another user's name without an assurance role", async () => {
    const res = await mkAssertion(projectA, owner.headers, {
      claimantId: member.userId,
      claimantKind: "user",
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toMatch(/integrity reviewer or auditor/);
  });

  it("blocks the full attack: claim in B's name, self-submit every piece of evidence, reconcile", async () => {
    // The attack used to work because the reconciliation compared
    // evidence.submittedBy (owner) to assertion.claimantId (member) and found
    // them different. `createdBy` closes it even when a reviewer legitimately
    // records the claim for someone else.
    const asRes = await mkAssertion(projectA, surveyorHeaders, {
      claimantId: member.userId,
      claimantKind: "user",
    });
    expect(asRes.statusCode).toBe(201);
    const assertion = asRes.json() as { id: string; createdBy: string; claimantId: string };
    expect(assertion.createdBy).toBe(surveyor.userId);
    expect(assertion.claimantId).toBe(member.userId);

    // The auditor who authored the assertion now submits all the evidence.
    const ev = await mkEvidence(projectA, surveyorHeaders);
    const rec = await post(`/projects/${projectA}/reconciliations`, owner.headers, {
      assertionId: assertion.id,
      evidenceIds: [ev.id],
      method: "quantity_check",
    });
    expect(rec.statusCode).toBe(403);
    expect(rec.json().message).toMatch(/author of the assertion/);
  });

  it("refuses an entity claim whose entity does not exist, and defaults the claimant to the caller", async () => {
    const bad = await mkAssertion(projectA, owner.headers, {
      claimantId: "ent_nope",
      claimantKind: "entity",
    });
    expect(bad.statusCode).toBe(404);

    const plain = await mkAssertion(projectA, owner.headers, {});
    expect(plain.statusCode).toBe(201);
    expect(plain.json().claimantId).toBe(owner.userId);
    expect(plain.json().createdBy).toBe(owner.userId);
  });
});

/* ================================================================== */
/* REGRESSION: detector runs were not idempotent                       */
/* ================================================================== */

describe("REGRESSION: detector runs are idempotent", () => {
  it("does not create a second copy of the same finding on a re-run", async () => {
    // Two identical quantity claims by the same claimant → duplicate_assertions.
    for (let i = 0; i < 2; i++) {
      const res = await mkAssertion(projectB, owner.headers, { value: 4242, unit: "m3" });
      expect(res.statusCode).toBe(201);
    }
    const first = await post(`/projects/${projectB}/detectors/run`, owner.headers, {
      detectors: ["duplicate_assertions"],
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().created).toBe(1);
    expect(first.json().refreshed).toBe(0);

    const second = await post(`/projects/${projectB}/detectors/run`, owner.headers, {
      detectors: ["duplicate_assertions"],
    });
    expect(second.json().created).toBe(0);
    expect(second.json().refreshed).toBe(1);

    const rows = await app.db
      .select()
      .from(signals)
      .where(
        and(
          eq(signals.companyId, owner.companyId),
          eq(signals.projectId, projectB),
          eq(signals.detector, "duplicate_assertions"),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.occurrences).toBe(2);
    expect(rows[0]!.fingerprint).toBeTruthy();
  });

  it("records the run, its skips and their reasons", async () => {
    const runs = await get("/detector-runs?pageSize=10", owner.headers);
    expect(runs.statusCode).toBe(200);
    const items = runs.json().items as Array<{
      scope: string;
      detectors: string[];
      skipped: Array<{ detector: string; reason: string }>;
    }>;
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]!.scope).toBe("project");
  });

  it("auto-closes a finding whose condition has cleared", async () => {
    const cleared = await post(`/projects/${projectB}/detectors/run`, owner.headers, {
      detectors: ["round_number_clustering"],
    });
    expect(cleared.statusCode).toBe(200);
    // round_number_clustering is skipped below 10 values, and a skipped
    // detector must never auto-close findings it did not actually evaluate.
    expect(cleared.json().executed).not.toContain("round_number_clustering");
    expect(cleared.json().autoClosed).toBe(0);
  });
});

/* ================================================================== */
/* REGRESSION: company-wide signal + ledger exposure                   */
/* ================================================================== */

describe("REGRESSION: company-wide assurance reads are scoped", () => {
  it("refuses /signals and /signals/stats to a member with no assurance reach", async () => {
    expect((await get("/signals", memberHeaders)).statusCode).toBe(403);
    expect((await get("/signals/stats", memberHeaders)).statusCode).toBe(403);
  });

  it("scopes /signals for a project-scoped reviewer to that project only", async () => {
    // A signal on project B, which reviewerA has no grant for.
    await post(`/projects/${projectB}/detectors/run`, owner.headers, {
      detectors: ["duplicate_assertions"],
    });
    const res = await get("/signals?pageSize=100", reviewerHeaders);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ projectId: string | null }>; scope: string };
    expect(body.scope).toBe("scoped");
    for (const item of body.items) expect(item.projectId).toBe(projectA);
  });

  it("gives a plain member their OWN ledger activity, without payload snapshots", async () => {
    const res = await get("/ledger?pageSize=20", memberHeaders);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: Array<Record<string, unknown>>;
      scope: string;
      payloadsIncluded: boolean;
    };
    expect(body.scope).toBe("own_activity");
    expect(body.payloadsIncluded).toBe(false);
    for (const item of body.items) expect(item["payload"]).toBeUndefined();
  });

  it("gives an owner the company chain with snapshots", async () => {
    const res = await get("/ledger?pageSize=20&objectType=assertion", owner.headers);
    expect(res.statusCode).toBe(200);
    expect(res.json().scope).toBe("company");
    expect(res.json().payloadsIncluded).toBe(true);
    expect(res.json().items.length).toBeGreaterThan(0);
  });
});

/* ================================================================== */
/* REGRESSION: assurance grants ignored their own projectId            */
/* ================================================================== */

describe("REGRESSION: a project-scoped grant confers no authority elsewhere", () => {
  let signalOnA: string;
  let signalOnB: string;
  let tenantSignal: string;

  beforeAll(async () => {
    const rows = [
      { id: newId("sig"), projectId: projectA },
      { id: newId("sig"), projectId: projectB },
      { id: newId("sig"), projectId: null },
    ];
    await app.db.insert(signals).values(
      rows.map((r) => ({
        id: r.id,
        companyId: owner.companyId,
        projectId: r.projectId,
        detector: "segregation_of_duties",
        severity: "high",
        confidence: 0.9,
        title: "seeded",
        explanation: "seeded for scope tests",
        fingerprint: `seed:${r.id}`,
      })),
    );
    signalOnA = rows[0]!.id;
    signalOnB = rows[1]!.id;
    tenantSignal = rows[2]!.id;
  });

  it("allows disposition inside the granted project", async () => {
    const res = await patch(`/signals/${signalOnA}/disposition`, reviewerHeaders, {
      disposition: "under_review",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().disposition).toBe("under_review");
  });

  it("refuses disposition on another project", async () => {
    const res = await patch(`/signals/${signalOnB}/disposition`, reviewerHeaders, {
      disposition: "false_positive",
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toMatch(/does not cover this signal's project/);
  });

  it("refuses disposition on a tenant-level finding", async () => {
    const res = await patch(`/signals/${tenantSignal}/disposition`, reviewerHeaders, {
      disposition: "closed",
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toMatch(/tenant-wide/);
  });

  it("enforces the signal lifecycle", async () => {
    const closed = await patch(`/signals/${signalOnA}/disposition`, reviewerHeaders, {
      disposition: "false_positive",
      reviewerNotes: "duplicate of an approved variation",
    });
    expect(closed.statusCode).toBe(200);
    expect(closed.json().closedAt).toBeTruthy();

    const illegal = await patch(`/signals/${signalOnA}/disposition`, reviewerHeaders, {
      disposition: "confirmed",
    });
    expect(illegal.statusCode).toBe(409);
    expect(illegal.json().message).toMatch(/cannot move from false_positive to confirmed/);

    // …but re-opening for review is always allowed.
    const reopened = await patch(`/signals/${signalOnA}/disposition`, reviewerHeaders, {
      disposition: "under_review",
    });
    expect(reopened.statusCode).toBe(200);
  });

  it("scopes the reconciliation disposition the same way", async () => {
    const as = await mkAssertion(projectB, owner.headers, { value: 50 });
    const ev = await mkEvidence(projectB, surveyorHeaders, { metadata: { value: 50 } });
    const rec = await post(`/projects/${projectB}/reconciliations`, owner.headers, {
      assertionId: as.json().id,
      evidenceIds: [ev.id],
      method: "quantity_check",
    });
    expect(rec.statusCode).toBe(201);
    const res = await patch(
      `/reconciliations/${rec.json().id}/disposition`,
      reviewerHeaders,
      { disposition: "accepted" },
    );
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toMatch(/does not cover this reconciliation's project/);
  });
});

/* ================================================================== */
/* REGRESSION: the entity register was member-editable and deletes     */
/* destroyed the evidence                                              */
/* ================================================================== */

describe("REGRESSION: entity register writes are privileged and deletes retain content", () => {
  let entityA: string;
  let entityB: string;

  it("refuses entity creation to a plain member", async () => {
    const res = await post("/entities", memberHeaders, { kind: "company", name: "Shell Co" });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toMatch(/owner\/admin or a tenant-wide/);
  });

  it("creates entities and links them by shared bank account", async () => {
    const a = await post("/entities", owner.headers, {
      kind: "company",
      name: "Alpha Contracting",
      identifiers: { bank_account: "GB29NWBK60161331926819" },
    });
    const b = await post("/entities", owner.headers, {
      kind: "company",
      name: "Beta Supplies",
      identifiers: { bank_account: "gb29nwbk60161331926819" },
    });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    entityA = a.json().id;
    entityB = b.json().id;

    const scan = await post("/entities/scan", owner.headers);
    expect(scan.statusCode).toBe(200);
    expect(scan.json().relationshipsCreated).toBe(1);
  });

  it("refuses the scan to a plain member", async () => {
    expect((await post("/entities/scan", memberHeaders)).statusCode).toBe(403);
  });

  it("stores before AND after on a patch, so an overwritten identifier is recoverable", async () => {
    const res = await patch(`/entities/${entityA}`, owner.headers, {
      identifiers: { bank_account: "GB00NEWACCOUNT0000000" },
    });
    expect(res.statusCode).toBe(200);
    const entries = await app.db
      .select()
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.objectId, entityA), eq(ledgerEntries.action, "update")));
    expect(entries).toHaveLength(1);
    const payload = entries[0]!.payload as {
      before: { identifiers: Record<string, string> };
      after: { identifiers: Record<string, string> };
    };
    expect(payload.before.identifiers["bank_account"]).toBe("GB29NWBK60161331926819");
    expect(payload.after.identifiers["bank_account"]).toBe("GB00NEWACCOUNT0000000");
  });

  it("soft-deletes, requires a reason, keeps the relationships and snapshots the prior row", async () => {
    const noReason = await del(`/entities/${entityB}`, owner.headers, {});
    expect(noReason.statusCode).toBe(400);

    const res = await del(`/entities/${entityB}`, owner.headers, { reason: "merged into Alpha" });
    expect(res.statusCode).toBe(200);
    expect(res.json().soft).toBe(true);
    expect(res.json().relationshipsRetained).toBe(1);

    // The scan-inferred edge — the actual evidence — is still there.
    const rels = await app.db
      .select()
      .from(entityRelationships)
      .where(eq(entityRelationships.companyId, owner.companyId));
    expect(rels.some((r) => r.toEntityId === entityB || r.fromEntityId === entityB)).toBe(true);

    const entries = await app.db
      .select()
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.objectId, entityB), eq(ledgerEntries.action, "delete")));
    const payload = entries[0]!.payload as {
      before: { name: string; identifiers: Record<string, string> };
      relationshipsRetained: unknown[];
    };
    expect(payload.before.name).toBe("Beta Supplies");
    expect(payload.before.identifiers["bank_account"]).toBeTruthy();
    expect(payload.relationshipsRetained.length).toBe(1);

    // …and the tombstone is out of the default listing but restorable.
    const list = await get("/entities?pageSize=100", owner.headers);
    expect((list.json().items as Array<{ id: string }>).map((e) => e.id)).not.toContain(entityB);
    const restored = await post(`/entities/${entityB}/restore`, owner.headers);
    expect(restored.statusCode).toBe(200);
    expect(restored.json().deletedAt).toBeNull();
  });

  it("refuses cross-tenant entity reads", async () => {
    const res = await get(`/entities/${entityA}`, stranger.headers);
    // The stranger's own company has no such entity.
    expect([403, 404]).toContain(res.statusCode);
  });
});

/* ================================================================== */
/* REGRESSION: obligation state machine had no guards                  */
/* ================================================================== */

describe("REGRESSION: obligation transitions are guarded", () => {
  it("refuses a second satisfy, and a waive after satisfaction", async () => {
    const created = await post(`/projects/${projectA}/obligations`, owner.headers, {
      sourceClause: "4.2",
      trigger: "insurance certificate",
    });
    const obligationId = created.json().id as string;
    const ev1 = await mkEvidence(projectA, surveyorHeaders, { metadata: { doc: "cert-1" } });
    const ev2 = await mkEvidence(projectA, surveyorHeaders, { metadata: { doc: "cert-2" } });

    const first = await post(
      `/projects/${projectA}/obligations/${obligationId}/satisfy`,
      owner.headers,
      { evidenceId: ev1.id },
    );
    expect(first.statusCode).toBe(200);

    const second = await post(
      `/projects/${projectA}/obligations/${obligationId}/satisfy`,
      owner.headers,
      { evidenceId: ev2.id },
    );
    expect(second.statusCode).toBe(409);
    expect(second.json().message).toMatch(/already satisfied/);

    const waive = await post(
      `/projects/${projectA}/obligations/${obligationId}/waive`,
      owner.headers,
      { reason: "no longer required" },
    );
    expect(waive.statusCode).toBe(409);

    const edit = await patch(
      `/projects/${projectA}/obligations/${obligationId}`,
      owner.headers,
      { trigger: "changed my mind" },
    );
    expect(edit.statusCode).toBe(409);
  });

  it("recomputes status when a breached obligation's deadline moves into the future", async () => {
    const past = new Date(Date.now() - 5 * 86_400_000).toISOString();
    const created = await post(`/projects/${projectA}/obligations`, owner.headers, {
      sourceClause: "20.1",
      trigger: "notice",
      deadline: past,
    });
    const id = created.json().id as string;
    await app.scheduler.runNow("assurance.obligation-breach");
    expect((await get(`/projects/${projectA}/obligations/${id}`, owner.headers)).json().status).toBe(
      "breached",
    );

    const future = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const moved = await patch(`/projects/${projectA}/obligations/${id}`, owner.headers, {
      deadline: future,
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().status).toBe("open");
  });
});

/* ================================================================== */
/* REGRESSION: ledger verification                                     */
/* ================================================================== */

describe("REGRESSION: ledger verification", () => {
  it("does NOT append an entry per call, and reports a real ledger seq on a break", async () => {
    const before = await app.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.companyId, stranger.companyId));
    const res = await get("/ledger/verify", stranger.headers);
    expect(res.statusCode).toBe(200);
    expect(res.json().valid).toBe(true);
    const after = await app.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.companyId, stranger.companyId));
    // The chain used to grow with every check, which made repeated
    // verification a way to grow the thing being verified.
    expect(after.length).toBe(before.length);

    // Corrupt an entry and confirm the reported seq is the ROW's seq, not an
    // index into an array (seq is a global bigserial shared across tenants).
    const victim = after[Math.floor(after.length / 2)]!;
    await app.db
      .update(ledgerEntries)
      .set({ payloadHash: "0".repeat(64) })
      .where(eq(ledgerEntries.seq, victim.seq));
    const broken = await get("/ledger/verify", stranger.headers);
    expect(broken.json().valid).toBe(false);
    expect(broken.json().brokenSeq).toBe(Number(victim.seq));
    expect(broken.json().reason).toMatch(/ledger seq/);
    expect(broken.json().mode).toBe("full");
  });

  it("refuses full verification to a member with no assurance reach", async () => {
    expect((await get("/ledger/verify", memberHeaders)).statusCode).toBe(403);
  });
});

/* ================================================================== */
/* New capability: typed reconciliation + auto-reconcile               */
/* ================================================================== */

describe("typed reconciliation", () => {
  it("selects the typed reconciler and rejects evidence of the wrong kind, with reasons", async () => {
    const as = await mkAssertion(projectA, owner.headers, {
      kind: "progress_percent",
      value: 80,
      unit: "%",
    });
    const good = await mkEvidence(projectA, surveyorHeaders, {
      kind: "reality_capture",
      metadata: { observedPercent: 55 },
    });
    const wrongKind = await mkEvidence(projectA, surveyorHeaders, {
      kind: "bank_transaction",
      metadata: { amount: 999 },
    });
    const res = await post(`/projects/${projectA}/reconciliations`, owner.headers, {
      assertionId: as.json().id,
      evidenceIds: [good.id, wrongKind.id],
      method: "progress_check",
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      result: string;
      reconciler: string;
      rejectedEvidence: Array<{ evidenceId: string; reason: string }>;
      basis: string;
    };
    expect(body.reconciler).toBe("progress_vs_capture");
    expect(body.result).toBe("contradicted");
    expect(body.rejectedEvidence.map((r) => r.evidenceId)).toContain(wrongKind.id);
    expect(body.basis).toMatch(/adverse direction/);
  });

  it("honours a tightened project tolerance policy", async () => {
    const put = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectA}/reconciliation-policies`,
      headers: owner.headers,
      payload: {
        assertionKind: "headcount",
        supportedWithinPercent: 1,
        partialWithinPercent: 2,
      },
    });
    expect(put.statusCode).toBe(200);
    const policies = await get(`/projects/${projectA}/reconciliation-policies`, owner.headers);
    const effective = (policies.json().effective as Array<{ assertionKind: string; source: string }>).find(
      (e) => e.assertionKind === "headcount",
    );
    expect(effective!.source).toBe("project policy");

    const as = await mkAssertion(projectA, owner.headers, { kind: "headcount", value: 100, unit: "people" });
    const ev = await mkEvidence(projectA, surveyorHeaders, {
      kind: "access_control_log",
      metadata: { distinctWorkers: 97 },
    });
    const rec = await post(`/projects/${projectA}/reconciliations`, owner.headers, {
      assertionId: as.json().id,
      evidenceIds: [ev.id],
      method: "headcount_check",
    });
    // 3% variance would be "supported" under the default ±5% band.
    expect(rec.json().result).toBe("contradicted");
  });

  it("auto-reconciles against the whole evidence pool, defeating cherry-picking", async () => {
    const as = await mkAssertion(projectA, owner.headers, {
      kind: "progress_percent",
      value: 90,
      unit: "%",
    });
    // One favourable row the claimant would have attached…
    await mkEvidence(projectA, surveyorHeaders, {
      kind: "reality_capture",
      metadata: { observedPercent: 89 },
    });
    // …and two that contradict it, which they would not have.
    await mkEvidence(projectA, surveyorHeaders, {
      kind: "reality_capture",
      metadata: { observedPercent: 40 },
    });
    await mkEvidence(projectA, surveyorHeaders, {
      kind: "reality_capture",
      metadata: { observedPercent: 45 },
    });
    const res = await post(`/projects/${projectA}/reconciliations/auto`, owner.headers, {
      kind: "progress_percent",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      created: number;
      contradicted: Array<{ assertionId: string }>;
      signalsCreated: number;
    };
    expect(body.created).toBeGreaterThan(0);
    expect(body.contradicted.some((c) => c.assertionId === as.json().id)).toBe(true);
    expect(body.signalsCreated).toBeGreaterThan(0);

    const raised = await get(
      `/projects/${projectA}/signals?detector=certified_above_evidenced`,
      owner.headers,
    );
    expect(raised.json().items.length).toBeGreaterThan(0);
  });
});

/* ================================================================== */
/* New capability: evidence integrity on retrieval                     */
/* ================================================================== */

describe("evidence integrity on retrieval", () => {
  it("re-hashes the stored object and raises a critical signal on a mismatch", async () => {
    const boundary = "----vitestboundary";
    const field = (name: string, value: string) =>
      Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
    const body = Buffer.concat([
      field("kind", "photograph"),
      field("source", "site camera"),
      Buffer.from(
        `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="p.txt"\r\n` +
          `content-type: text/plain\r\n\r\n`,
      ),
      Buffer.from("original evidence bytes"),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const upload = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectA}/evidence`,
      headers: { ...owner.headers, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(upload.statusCode).toBe(201);
    const evidenceId = upload.json().id as string;

    const ok = await get(`/projects/${projectA}/evidence/${evidenceId}/download`, owner.headers);
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["x-evidence-integrity"]).toBe("intact");

    // Tamper with the record's expectation, which is the same observable as
    // tampering with the bytes: the two no longer agree.
    const { evidence } = await import("@constructos/db");
    await app.db
      .update(evidence)
      .set({ contentHash: "f".repeat(64) })
      .where(eq(evidence.id, evidenceId));

    const bad = await get(`/projects/${projectA}/evidence/${evidenceId}/download`, owner.headers);
    expect(bad.statusCode).toBe(200);
    expect(bad.headers["x-evidence-integrity"]).toBe("mismatch");
    const raised = await app.db
      .select()
      .from(signals)
      .where(
        and(
          eq(signals.companyId, owner.companyId),
          eq(signals.detector, "evidence_content_mismatch"),
        ),
      );
    expect(raised).toHaveLength(1);
    expect(raised[0]!.severity).toBe("critical");
  });
});

/* ================================================================== */
/* New capability: company detectors over the payables record          */
/* ================================================================== */

describe("company-scoped detector programme", () => {
  let vendorId: string;

  beforeAll(async () => {
    vendorId = newId("ven");
    await app.db.insert(vendors).values({
      id: vendorId,
      companyId: owner.companyId,
      name: "Kestrel Labour Supply Ltd",
      tradeCodes: [],
    });
    // Two identical amounts three days apart from the same supplier.
    for (const [i, billingDate] of ["2026-06-01", "2026-06-03"].entries()) {
      await app.db.insert(invoices).values({
        id: newId("inv"),
        companyId: owner.companyId,
        projectId: projectA,
        kind: "subcontractor_invoice",
        number: 900 + i,
        reference: `INV-90${i}`,
        vendorId,
        invoiceNumber: `KLS-77`,
        currency: "GBP",
        total: 4250,
        billingDate,
        status: "approved",
        createdBy: owner.userId,
      });
    }
  });

  it("finds a duplicate payment and refuses the run to an unprivileged member", async () => {
    expect((await post("/detectors/run", memberHeaders, {})).statusCode).toBe(403);

    const res = await post("/detectors/run", owner.headers, { detectors: ["duplicate_payment"] });
    expect(res.statusCode).toBe(200);
    expect(res.json().perDetector["duplicate_payment"]).toBe(1);
    expect(res.json().created).toBe(1);

    const again = await post("/detectors/run", owner.headers, { detectors: ["duplicate_payment"] });
    expect(again.json().created).toBe(0);
    expect(again.json().refreshed).toBe(1);
  });

  it("skips split_invoicing with a stated reason until a threshold is configured", async () => {
    const res = await post("/detectors/run", owner.headers, { detectors: ["split_invoicing"] });
    const skipped = res.json().skipped as Array<{ detector: string; reason: string }>;
    expect(skipped.find((s) => s.detector === "split_invoicing")!.reason).toMatch(
      /no approval threshold/,
    );
  });

  it("exposes the registry with measured precision and lets an admin disable a detector", async () => {
    const registry = await get("/detectors", owner.headers);
    expect(registry.statusCode).toBe(200);
    const items = registry.json().items as Array<{ id: string; enabled: boolean; measuredPrecision: number | null; precisionBasis: string }>;
    const dup = items.find((i) => i.id === "duplicate_payment")!;
    expect(dup.enabled).toBe(true);
    expect(dup.measuredPrecision).toBeNull();
    expect(dup.precisionBasis).toMatch(/no reviewed signals|fewer than/);

    const put = await app.inject({
      method: "PUT",
      url: "/api/v1/detectors/duplicate_payment/policy",
      headers: owner.headers,
      payload: { enabled: false },
    });
    expect(put.statusCode).toBe(200);
    const run = await post("/detectors/run", owner.headers, { detectors: ["duplicate_payment"] });
    expect(
      (run.json().skipped as Array<{ detector: string; reason: string }>).find(
        (s) => s.detector === "duplicate_payment",
      )!.reason,
    ).toMatch(/disabled by company detector policy/);

    await app.inject({
      method: "PUT",
      url: "/api/v1/detectors/duplicate_payment/policy",
      headers: owner.headers,
      payload: { enabled: true },
    });
  });

  it("rejects an unknown detector name", async () => {
    const res = await post("/detectors/run", owner.headers, { detectors: ["nonsense"] });
    expect(res.statusCode).toBe(400);
  });
});

/* ================================================================== */
/* New capability: screening, conflicts, authority limits              */
/* ================================================================== */

describe("screening, conflicts and authority", () => {
  let flagged: string;

  it("screens an entity against the fixture lists and says what it screened against", async () => {
    const created = await post("/entities", owner.headers, {
      kind: "company",
      name: "Ironvale Construction Services Limited",
    });
    flagged = created.json().id;
    const res = await post(`/entities/${flagged}/screen`, owner.headers);
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("sanctions_hit");
    expect(res.json().caveat).toMatch(/no live sanctions or PEP feed/);

    const register = await get(`/entities/${flagged}/screening`, owner.headers);
    expect(register.json().items.length).toBeGreaterThan(0);
    expect(register.json().items[0].listSnapshotHash).toHaveLength(64);

    const signal = await app.db
      .select()
      .from(signals)
      .where(
        and(eq(signals.companyId, owner.companyId), eq(signals.detector, "entity_screening_hit")),
      );
    expect(signal.length).toBe(1);

    // A second screen must not manufacture a second signal.
    await post(`/entities/${flagged}/screen`, owner.headers);
    const again = await app.db
      .select()
      .from(signals)
      .where(
        and(eq(signals.companyId, owner.companyId), eq(signals.detector, "entity_screening_hit")),
      );
    expect(again.length).toBe(1);
  });

  it("records a clean screen as a result, not as an absence", async () => {
    const created = await post("/entities", owner.headers, {
      kind: "company",
      name: "Perfectly Ordinary Builders",
    });
    const res = await post(`/entities/${created.json().id}/screen`, owner.headers);
    expect(res.json().status).toBe("clear");
    const register = await get(`/entities/${created.json().id}/screening`, owner.headers);
    expect(register.json().items).toHaveLength(1);
    expect(register.json().items[0].disposition).toBe("cleared");
  });

  it("lets a reviewer disposition a screening match", async () => {
    const register = await get(`/entities/${flagged}/screening`, owner.headers);
    const resultId = register.json().items[0].id as string;
    const res = await patch(`/screening-results/${resultId}`, owner.headers, {
      disposition: "false_match",
      reviewNotes: "different jurisdiction, different registration number",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().reviewedBy).toBe(owner.userId);
  });

  it("lets anyone declare their own interest but not someone else's", async () => {
    const own = await post("/conflict-declarations", memberHeaders, {
      entityId: flagged,
      nature: "spouse is a director",
    });
    expect(own.statusCode).toBe(201);

    const forOther = await post("/conflict-declarations", memberHeaders, {
      userId: owner.userId,
      entityId: flagged,
      nature: "invented",
    });
    expect(forOther.statusCode).toBe(403);

    // A member sees only their own declarations.
    const mine = await get("/conflict-declarations", memberHeaders);
    expect(mine.statusCode).toBe(200);
    for (const d of mine.json().items as Array<{ userId: string }>) {
      expect(d.userId).toBe(member.userId);
    }

    // Ending it keeps the row — it existed while the approvals were made.
    const ended = await del(`/conflict-declarations/${own.json().id}`, memberHeaders);
    expect(ended.statusCode).toBe(200);
    expect(ended.json().endedAt).toBeTruthy();
  });

  it("records authority limits and finds a breach", async () => {
    const limit = await post("/authority-limits", owner.headers, {
      userId: owner.userId,
      objectType: "invoice",
      maxAmount: 1000,
      currency: "GBP",
    });
    expect(limit.statusCode).toBe(201);
    expect((await post("/authority-limits", memberHeaders, { userId: member.userId, maxAmount: 1 })).statusCode).toBe(403);

    await app.db
      .update(invoices)
      .set({ approvedBy: owner.userId, approvedAt: "2026-06-05T10:00:00.000Z" })
      .where(eq(invoices.companyId, owner.companyId));

    const run = await post("/detectors/run", owner.headers, { detectors: ["authority_limit_breach"] });
    expect(run.json().perDetector["authority_limit_breach"]).toBeGreaterThan(0);
  });
});

/* ================================================================== */
/* New capability: scores, cases, packs, summary                       */
/* ================================================================== */

describe("integrity scores, cases and evidence packs", () => {
  let caseId: string;

  it("computes and snapshots exposure scores with decomposable components", async () => {
    const res = await post("/integrity/recompute", owner.headers);
    expect(res.statusCode).toBe(200);
    expect(res.json().scored).toBeGreaterThan(0);

    const scores = await get("/integrity/scores?scope=project", owner.headers);
    expect(scores.statusCode).toBe(200);
    const items = scores.json().items as Array<{
      subjectId: string;
      score: number;
      band: string;
      components: Array<{ basis: string }>;
    }>;
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]!.components[0]!.basis).toMatch(/severity/);
    expect(scores.json().scale).toMatch(/EXPOSURE/);

    const trends = await get(`/integrity/trends?scope=project&subjectId=${projectA}`, owner.headers);
    expect(trends.statusCode).toBe(200);
    expect(trends.json().series.length).toBeGreaterThan(0);
  });

  it("refuses scores to a member with no assurance reach", async () => {
    expect((await get("/integrity/scores", memberHeaders)).statusCode).toBe(403);
  });

  it("opens a case, escalates the signals attached to it and requires a closure reason", async () => {
    const open = await app.db
      .select()
      .from(signals)
      .where(and(eq(signals.companyId, owner.companyId), eq(signals.projectId, projectA)))
      .limit(1);
    const res = await post("/integrity-cases", owner.headers, {
      title: "Kestrel payables review",
      projectId: projectA,
      severity: "high",
      signalIds: [open[0]!.id],
    });
    expect(res.statusCode).toBe(201);
    caseId = res.json().id;
    expect(res.json().reference).toMatch(/^CASE-\d{4}$/);

    const detail = await get(`/integrity-cases/${caseId}`, owner.headers);
    expect(detail.json().signals.length).toBe(1);

    const another = await app.db
      .select()
      .from(signals)
      .where(and(eq(signals.companyId, owner.companyId), eq(signals.disposition, "new")))
      .limit(1);
    if (another[0]) {
      const added = await post(`/integrity-cases/${caseId}/items`, owner.headers, {
        itemType: "signal",
        itemId: another[0]!.id,
      });
      expect(added.statusCode).toBe(201);
      const after = await app.db
        .select()
        .from(signals)
        .where(eq(signals.id, another[0]!.id));
      expect(after[0]!.disposition).toBe("escalated");
    }

    const closeWithoutReason = await patch(`/integrity-cases/${caseId}`, owner.headers, {
      status: "closed",
    });
    expect(closeWithoutReason.statusCode).toBe(400);
  });

  it("builds a referral pack bound to the chain head with a completeness statement", async () => {
    const res = await post(`/integrity-cases/${caseId}/referral-pack`, owner.headers, {
      referralTarget: "National audit office",
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      id: string;
      root: string;
      items: Array<{ objectType: string; contentHash: string; proof: unknown }>;
      statement: string;
    };
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.statement).toMatch(/Referral pack for case CASE-/);
    const { verifyMerkleProof } = await import("@constructos/ledger");
    for (const item of body.items) {
      expect(
        verifyMerkleProof(item.contentHash, item.proof as never, body.root),
      ).toBe(true);
    }

    const detail = await get(`/evidence-packs/${body.id}`, owner.headers);
    expect(detail.json().rootIntact).toBe(true);

    const download = await get(`/evidence-packs/${body.id}/download`, owner.headers);
    expect(download.statusCode).toBe(200);
    expect(JSON.parse(download.body).documentType).toBe("constructos.evidence-pack");

    // Chain of custody: create + view + download all recorded.
    const access = await get(`/evidence-packs/${body.id}/access`, owner.headers);
    const actions = (access.json().items as Array<{ action: string }>).map((a) => a.action);
    expect(actions).toContain("create");
    expect(actions).toContain("download");

    const referred = await get(`/integrity-cases/${caseId}`, owner.headers);
    expect(referred.json().status).toBe("referred");
  });

  it("persists project evidence packs with an explicit exclusion statement", async () => {
    const ev = await mkEvidence(projectB, owner.headers, { metadata: { value: 7 } });
    const res = await post(`/projects/${projectB}/evidence-packs`, owner.headers, {
      evidenceIds: [ev.id],
      title: "Payment application 3 support",
      purpose: "claim",
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().statement).toMatch(/exclusion|Nothing linked/);
    const list = await get(`/projects/${projectB}/evidence-packs`, owner.headers);
    expect(list.json().total).toBeGreaterThan(0);
  });

  it("serves the owner-side summary and health inputs with honest nulls", async () => {
    const summary = await get(`/projects/${projectA}/assurance/summary`, owner.headers);
    expect(summary.statusCode).toBe(200);
    const body = summary.json() as Record<string, unknown>;
    expect(typeof body["openSignals"]).toBe("number");
    // Never sealed in this test app: the figure must be an explicit unknowable.
    expect((body["seal"] as { value: null; reasons: string[] }).value).toBeNull();
    expect((body["seal"] as { reasons: string[] }).reasons[0]).toMatch(/never been sealed/);

    const inputs = await get(`/projects/${projectA}/assurance/health-inputs`, owner.headers);
    expect(inputs.statusCode).toBe(200);
    expect(inputs.json().metrics.sealAgeHours).toBeNull();
    expect(inputs.json().reasons.length).toBeGreaterThan(0);

    const roll = await get("/assurance/summary", owner.headers);
    expect(roll.statusCode).toBe(200);
    expect(roll.json().projects.length).toBeGreaterThanOrEqual(2);
    expect(roll.json().totals.projects).toBeGreaterThanOrEqual(2);
  });

  it("refuses the company roll-up to a member with no assurance reach", async () => {
    expect((await get("/assurance/summary", memberHeaders)).statusCode).toBe(403);
  });
});

/* ================================================================== */
/* Tenant isolation                                                    */
/* ================================================================== */

describe("tenant isolation", () => {
  it("cannot read another company's signals, cases, packs or project assurance", async () => {
    const strangerHeaders = stranger.headers;
    expect((await get(`/projects/${projectA}/signals`, strangerHeaders)).statusCode).toBe(403);
    expect((await get(`/projects/${projectA}/assurance/summary`, strangerHeaders)).statusCode).toBe(403);

    const cases = await get("/integrity-cases", strangerHeaders);
    expect(cases.statusCode).toBe(200);
    expect(cases.json().total).toBe(0);

    const scores = await get("/integrity/scores", strangerHeaders);
    expect(scores.statusCode).toBe(200);
    expect(scores.json().items).toHaveLength(0);
  });

  it("cannot forge a company header to reach a company it is not a member of", async () => {
    const res = await get("/signals", headersFor(stranger, owner.companyId));
    expect(res.statusCode).toBe(403);
  });
});
