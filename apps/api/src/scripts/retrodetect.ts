/**
 * Retrospective detection run — the spec Vol III §7 milestone, scoped honestly.
 *
 * The spec asks for a retrospective run over "one completed public project
 * with a known integrity outcome" and a precision/recall figure against that
 * known case. We do not have customer data, so this harness does the next
 * best thing that is possible today: it boots the full API against an
 * in-memory database, plants a set of KNOWN fraud/failure schemes into a
 * synthetic project through the real API routes, seeds a second project with
 * innocent data as a clean control, runs every detector, and scores what
 * fired against the planted ground truth.
 *
 *   recall    = planted schemes caught / planted schemes
 *   precision = signals attributable to planted schemes / all signals raised
 *
 * The clean control project measures false positives directly: any detector
 * that fires there is a precision failure. The script exits non-zero when
 * recall < 100% or the clean project raises any signal, so it doubles as a
 * regression harness for the detector suite.
 *
 * Run with:  pnpm --filter @constructos/api eval:retrodetect
 * Docs:      docs/retrospective-detection.md
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { paymentClaims } from "@constructos/db";
import { buildTestApp, registerActor } from "../test/helpers.js";
import { addDaysISO, todayISO } from "../modules/field/dates.js";

/* ------------------------------------------------------------------ */
/* Ground truth                                                        */
/* ------------------------------------------------------------------ */

interface PlantedScheme {
  id: string;
  name: string;
  /** spec function number(s) the detector implements (Vol II domain # or Vol III) */
  specRef: string;
  expectedDetector: string;
  /** where the signal is expected: on the planted project, or tenant-wide */
  scope: "project" | "company";
  plant: () => Promise<void>;
}

/**
 * The 11 planted schemes. Schemes 1-3 deliberately share one fabricated
 * cost-assertion population (see plantFabricatedCostBook): a manually
 * invented payment book is exactly the kind of dataset that trips the
 * round-number, duplicate and Benford detectors at once, and each detector
 * keys on a different signature within it.
 */
const GROUND_TRUTH: PlantedScheme[] = [
  {
    id: "round_numbers",
    name: "Round-number cost fabrication (12 round cost assertions)",
    specRef: "Domain A #57",
    expectedDetector: "round_number_clustering",
    scope: "project",
    plant: plantRoundNumbers,
  },
  {
    id: "duplicate_claims",
    name: "Double claim (3 identical cost assertions, same claimant, days apart)",
    specRef: "Domain A #55-56",
    expectedDetector: "duplicate_assertions",
    scope: "project",
    plant: plantDuplicateClaims,
  },
  {
    id: "fabricated_values",
    name: "Fabricated value population (54 cost assertions, flat first-digit spread)",
    specRef: "Domain A #58",
    expectedDetector: "benford_first_digit",
    scope: "project",
    plant: plantBenfordViolation,
  },
  {
    id: "self_approval",
    name: "Self-approval (workflow started and approved by the same user)",
    specRef: "Domain A #39-40",
    expectedDetector: "segregation_of_duties",
    scope: "project",
    plant: plantSelfApproval,
  },
  {
    id: "rubber_stamping",
    name: "Rubber-stamp approvals (3 steps approved seconds after assignment)",
    specRef: "Domain A #37",
    expectedDetector: "approval_velocity",
    scope: "project",
    plant: plantRubberStamping,
  },
  {
    id: "over_certification",
    name: "Over-certification (2 rate assertions contradicted by independent survey)",
    specRef: "Domain A #65-66",
    expectedDetector: "contradicted_claimant",
    scope: "project",
    plant: plantOverCertification,
  },
  {
    id: "colluding_vendors",
    name: "Colluding vendors (2 nominally independent vendors, one bank account)",
    specRef: "Domain A #9",
    expectedDetector: "shared_identifier",
    scope: "company", // /entities/scan signals are tenant-level (no projectId)
    plant: plantColludingVendors,
  },
  {
    id: "missed_time_bar",
    name: "Missed notice time bar (FIDIC 20.2 event 90 days old, never noticed)",
    specRef: "Domain C #225-231 (M8 time-bar engine)",
    expectedDetector: "time_bar_missed",
    scope: "project",
    plant: plantMissedTimeBar,
  },
  {
    id: "ignored_payment_claim",
    name: "Ignored payment claim (HGCRA claim served, response deadline passed)",
    specRef: "Domain F #361 (M10 deemed-liability sweep)",
    expectedDetector: "payment_deemed_liability",
    scope: "project",
    plant: plantIgnoredPaymentClaim,
  },
  {
    id: "covenant_breach",
    name: "Financial covenant breach (DSCR reading below gte threshold)",
    specRef: "Domain O #742-743 (M14 covenant monitor)",
    expectedDetector: "covenant_breach",
    scope: "project",
    plant: plantCovenantBreach,
  },
  {
    id: "contingency_burn",
    name: "Contingency exhaustion (drawdown leaves under 20% remaining)",
    specRef: "Domain H #473 (M13 contingency tracker)",
    expectedDetector: "contingency_exhaustion",
    scope: "project",
    plant: plantContingencyBurn,
  },
];

/* ------------------------------------------------------------------ */
/* Harness context + tiny API helpers                                  */
/* ------------------------------------------------------------------ */

interface Actor {
  userId: string;
  headers: Record<string, string>;
}

interface Ctx {
  app: FastifyInstance;
  companyId: string;
  /** owner A — registered the company; the operational claimant */
  ownerA: Actor;
  /** member B — invited, project_admin on both projects; second actor / evidence source */
  memberB: Actor;
  /** reviewer R — integrity_reviewer assurance grant; runs detectors, reads signals */
  reviewerR: Actor;
  plantedProjectId: string;
  cleanProjectId: string;
  plantedContractId: string;
  cleanContractId: string;
}

/** Populated by setup() before any plant runs. */
const ctx = {} as Ctx;

async function api(
  actor: Actor,
  method: "GET" | "POST" | "PATCH",
  url: string,
  payload?: unknown,
): Promise<Record<string, unknown>> {
  const res = await ctx.app.inject({
    method,
    url: `/api/v1${url}`,
    headers: actor.headers,
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
  if (res.statusCode !== 200 && res.statusCode !== 201) {
    throw new Error(`${method} ${url} -> ${res.statusCode}: ${res.body}`);
  }
  return res.json() as Record<string, unknown>;
}

const post = (actor: Actor, url: string, payload?: unknown) => api(actor, "POST", url, payload);
const get = (actor: Actor, url: string) => api(actor, "GET", url);

async function postAssertion(
  actor: Actor,
  projectId: string,
  body: Record<string, unknown>,
): Promise<{ id: string }> {
  return (await post(actor, `/projects/${projectId}/assertions`, body)) as unknown as {
    id: string;
  };
}

/** Create a workflow template, start an instance, return its pending steps. */
async function startWorkflow(
  starter: Actor,
  projectId: string,
  templateName: string,
  steps: { name: string; assigneeId: string; parallel?: boolean }[],
  record: { recordType: string; recordId: string },
): Promise<{ id: string; assigneeId: string }[]> {
  const tpl = (await post(ctx.ownerA, "/workflow-templates", {
    name: templateName,
    recordType: record.recordType,
    steps: steps.map((s) => ({
      name: s.name,
      type: "approval",
      assigneeIds: [s.assigneeId],
      ...(s.parallel ? { parallel: true } : {}),
    })),
  })) as unknown as { id: string };
  const started = (await post(starter, `/projects/${projectId}/workflows/start`, {
    templateId: tpl.id,
    ...record,
  })) as unknown as { steps: { id: string; assigneeId: string; decision: string }[] };
  return started.steps.filter((s) => s.decision === "pending");
}

async function approveStep(actor: Actor, stepId: string): Promise<void> {
  await post(actor, `/workflow-steps/${stepId}/decide`, { decision: "approved" });
}

/* ------------------------------------------------------------------ */
/* Planted schemes (all via real API routes; DB touches are flagged)   */
/* ------------------------------------------------------------------ */

/**
 * Schemes 1-3 — the fabricated cost book. All three statistical detectors
 * run over the same cost/quantity assertion population of the project, so
 * the three plants are designed as one coherent invented payment book:
 *   - 12 suspiciously round values (owner A)          -> round_number_clustering
 *   - 3 identical resubmissions days apart (member B) -> duplicate_assertions
 *   - 54 values with a flat/high first-digit spread   -> benford_first_digit
 * Together: 69 values, 96% divisible by 1000 (>40% threshold) and a
 * first-digit chi-square ~34 against Benford (>30 = high severity).
 */
async function plantRoundNumbers(): Promise<void> {
  const roundValues = [
    13000, 21000, 26000, 34000, 38000, 45000, 49000, 52000, 63000, 71000, 87000, 92000,
  ];
  for (const value of roundValues) {
    await postAssertion(ctx.ownerA, ctx.plantedProjectId, {
      kind: "cost",
      value,
      unit: "GBP",
      basis: "monthly application — office estimate",
    });
  }
}

async function plantDuplicateClaims(): Promise<void> {
  const today = todayISO();
  for (const daysAgo of [6, 4, 1]) {
    await postAssertion(ctx.memberB, ctx.plantedProjectId, {
      kind: "cost",
      value: 47250,
      unit: "GBP",
      basis: "resubmitted interim claim item 4.2",
      assertedAt: `${addDaysISO(today, -daysAgo)}T09:15:00Z`,
    });
  }
}

async function plantBenfordViolation(): Promise<void> {
  // Fabricated books flatten the first-digit curve; this one is flat with a
  // high-digit skew (4x d1, 6x d2..d8, 8x d9 = 54 values, all unique).
  const countsByDigit: Record<number, number> = { 1: 4, 2: 6, 3: 6, 4: 6, 5: 6, 6: 6, 7: 6, 8: 6, 9: 8 };
  for (let digit = 1; digit <= 9; digit++) {
    for (let j = 1; j <= countsByDigit[digit]!; j++) {
      await postAssertion(ctx.memberB, ctx.plantedProjectId, {
        kind: "cost",
        value: digit * 100000 + j * 1000,
        unit: "GBP",
        basis: `variation account item ${digit}.${j}`,
      });
    }
  }
}

async function plantSelfApproval(): Promise<void> {
  // Owner A starts the approval workflow AND approves its only step.
  const steps = await startWorkflow(
    ctx.ownerA,
    ctx.plantedProjectId,
    "Payment application sign-off (single)",
    [{ name: "Approve payment application", assigneeId: ctx.ownerA.userId }],
    { recordType: "payment_application", recordId: "PA-104" },
  );
  await approveStep(ctx.ownerA, steps[0]!.id);
}

async function plantRubberStamping(): Promise<void> {
  // A starts a 3-signature workflow; B approves all three seconds after
  // assignment (well under the 60s plausible-review floor).
  const steps = await startWorkflow(
    ctx.ownerA,
    ctx.plantedProjectId,
    "Variation order triple sign-off",
    [
      { name: "Commercial review", assigneeId: ctx.memberB.userId, parallel: true },
      { name: "Technical review", assigneeId: ctx.memberB.userId, parallel: true },
      { name: "Final approval", assigneeId: ctx.memberB.userId, parallel: true },
    ],
    { recordType: "variation_order", recordId: "VO-017" },
  );
  for (const step of steps) await approveStep(ctx.memberB, step.id);
}

async function plantOverCertification(): Promise<void> {
  // A certifies rates that B's independent surveys contradict (>15% variance
  // twice for the same claimant). kind "rate" keeps these two values out of
  // the cost-population statistics used by schemes 1-3.
  const cases = [
    { asserted: 118.4, surveyed: 62.1, item: "rock excavation rate CH 1+200" },
    { asserted: 96.75, surveyed: 55.9, item: "rebar fixing rate — deck span 3" },
  ];
  for (const c of cases) {
    const assertion = await postAssertion(ctx.ownerA, ctx.plantedProjectId, {
      kind: "rate",
      value: c.asserted,
      unit: "GBP/m3",
      basis: `certified rate — ${c.item}`,
    });
    const evidence = (await post(ctx.memberB, `/projects/${ctx.plantedProjectId}/evidence`, {
      kind: "survey",
      source: "independent quantity surveyor site measure",
      independenceScore: 0.85,
      metadata: { value: c.surveyed, item: c.item },
    })) as unknown as { id: string };
    await post(ctx.memberB, `/projects/${ctx.plantedProjectId}/reconciliations`, {
      assertionId: assertion.id,
      evidenceIds: [evidence.id],
      method: "survey_comparison",
    });
  }
}

async function plantColludingVendors(): Promise<void> {
  // Two nominally independent vendors paying into the same bank account.
  // The signal fires when /entities/scan runs (run phase).
  const sharedAccount = "GB82-WEST-1234-5698-7654-32";
  await post(ctx.ownerA, "/entities", {
    kind: "company",
    name: "Marlin Groundworks Ltd",
    jurisdiction: "GB",
    identifiers: { company_number: "09123471", bank_account: sharedAccount },
  });
  await post(ctx.ownerA, "/entities", {
    kind: "company",
    name: "Pelican Formwork Ltd",
    jurisdiction: "GB",
    identifiers: { company_number: "11554902", bank_account: sharedAccount },
  });
}

async function plantMissedTimeBar(): Promise<void> {
  // FIDIC 20.2 carries a 28-day notice time bar. An event dated 90 days ago
  // with no notice served is 62 days past its deadline; the lazy time-bar
  // sweep (triggered by the events list read in the run phase) raises the
  // signal. The API accepts past event dates, so no DB work is needed.
  await post(
    ctx.ownerA,
    `/projects/${ctx.plantedProjectId}/contracts/${ctx.plantedContractId}/events`,
    {
      kind: "claim_notice",
      clauseRef: "20.2",
      title: "Unforeseen ground conditions at CH 2+400",
      description: "Running sand encountered below formation level; claim never noticed.",
      eventDate: addDaysISO(todayISO(), -90),
      costImpactEstimate: 412000,
      timeImpactDaysEstimate: 21,
    },
  );
}

async function plantIgnoredPaymentClaim(): Promise<void> {
  const claim = (await post(ctx.ownerA, `/projects/${ctx.plantedProjectId}/payment-claims`, {
    regime: "uk_hgcra",
    referenceDate: addDaysISO(todayISO(), -30),
    claimedAmount: 182563.44,
    currency: "GBP",
    description: "Interim application 14 — never answered by the payer",
  })) as unknown as { id: string };
  await post(ctx.ownerA, `/projects/${ctx.plantedProjectId}/payment-claims/${claim.id}/serve`, {
    method: "portal",
  });
  // DB BACKDATE (the one unavoidable direct write): the serve endpoint
  // always computes the statutory response deadline forward from the actual
  // date of service (max(referenceDate, today) + regime days), so a claim
  // served through the API can never already be past its deadline. A
  // genuinely ignored claim only exists after real days pass; we age this
  // one in the database instead. Same technique as payments.test.ts.
  await ctx.app.db
    .update(paymentClaims)
    .set({
      servedAt: `${addDaysISO(todayISO(), -12)}T10:00:00.000Z`,
      responseDeadline: addDaysISO(todayISO(), -7),
    })
    .where(eq(paymentClaims.id, claim.id));
}

async function plantCovenantBreach(): Promise<void> {
  const facility = (await post(ctx.ownerA, `/projects/${ctx.plantedProjectId}/facilities`, {
    name: "Senior debt facility",
    lender: "Meridian Infrastructure Bank",
    instrument: "loan",
    currency: "GBP",
    committedAmount: 60_000_000,
  })) as unknown as { id: string };
  const covenant = (await post(
    ctx.ownerA,
    `/projects/${ctx.plantedProjectId}/facilities/${facility.id}/covenants`,
    { name: "Debt service cover ratio", operator: "gte", threshold: 1.2, unit: "x" },
  )) as unknown as { id: string };
  // Non-compliant reading (1.04 < 1.2) — the signal fires on this POST.
  await post(ctx.ownerA, `/projects/${ctx.plantedProjectId}/covenants/${covenant.id}/readings`, {
    readingDate: todayISO(),
    value: 1.04,
    note: "Q3 certificate — revenue shortfall on tolling ramp-up",
  });
}

async function plantContingencyBurn(): Promise<void> {
  const contingency = (await post(ctx.ownerA, `/projects/${ctx.plantedProjectId}/contingencies`, {
    name: "Construction contingency",
    amount: 250_000,
    currency: "GBP",
  })) as unknown as { id: string };
  // 205k of 250k drawn -> 45k (18%) remaining, crossing the 20% line.
  await post(
    ctx.ownerA,
    `/projects/${ctx.plantedProjectId}/contingencies/${contingency.id}/drawdowns`,
    { amount: 205_000, reason: "Absorbing ground-condition claims", drawnAt: todayISO() },
  );
}

/* ------------------------------------------------------------------ */
/* Clean control — innocent data on a second project                   */
/* ------------------------------------------------------------------ */

async function seedCleanControl(): Promise<void> {
  const projectId = ctx.cleanProjectId;
  const today = todayISO();

  // 60 natural cost values: log-uniform over 3 decades (Benford-conforming
  // by construction), non-round, unique.
  for (let i = 0; i < 60; i++) {
    const value = Math.round(Math.pow(10, 2 + (3 * (i + 0.5)) / 60) * 100) / 100;
    await postAssertion(ctx.ownerA, projectId, {
      kind: "cost",
      value,
      unit: "GBP",
      basis: `measured quantities x contract rates, item ${i + 1}`,
    });
  }

  // A rate assertion supported by independent evidence (variance < 5%).
  const assertion = await postAssertion(ctx.ownerA, projectId, {
    kind: "rate",
    value: 100.4,
    unit: "GBP/m3",
    basis: "certified rate — bulk fill",
  });
  const evidence = (await post(ctx.memberB, `/projects/${projectId}/evidence`, {
    kind: "survey",
    source: "independent quantity surveyor site measure",
    independenceScore: 0.85,
    metadata: { value: 101.9 },
  })) as unknown as { id: string };
  await post(ctx.memberB, `/projects/${projectId}/reconciliations`, {
    assertionId: assertion.id,
    evidenceIds: [evidence.id],
    method: "survey_comparison",
  });

  // A properly segregated approval: A starts, B (one step) approves.
  const steps = await startWorkflow(
    ctx.ownerA,
    projectId,
    "Payment application sign-off (segregated)",
    [{ name: "Approve payment application", assigneeId: ctx.memberB.userId }],
    { recordType: "payment_application", recordId: "PA-001" },
  );
  await approveStep(ctx.memberB, steps[0]!.id);

  // A healthy payment claim: served today, answered the same day in full.
  const claim = (await post(ctx.ownerA, `/projects/${projectId}/payment-claims`, {
    regime: "uk_hgcra",
    referenceDate: today,
    claimedAmount: 96341.27,
    currency: "GBP",
  })) as unknown as { id: string };
  await post(ctx.ownerA, `/projects/${projectId}/payment-claims/${claim.id}/serve`, {
    method: "portal",
  });
  await post(ctx.ownerA, `/projects/${projectId}/payment-claims/${claim.id}/respond`, {
    kind: "payment_notice",
    amount: 96341.27,
  });

  // A contract event noticed inside its FIDIC 20.2 time bar.
  const event = (await post(
    ctx.ownerA,
    `/projects/${projectId}/contracts/${ctx.cleanContractId}/events`,
    {
      kind: "claim_notice",
      clauseRef: "20.2",
      title: "Exceptional rainfall week 32",
      eventDate: addDaysISO(today, -3),
    },
  )) as unknown as { id: string };
  await post(
    ctx.ownerA,
    `/projects/${projectId}/contracts/${ctx.cleanContractId}/events/${event.id}/serve-notice`,
    { method: "email", reference: "LTR-0088" },
  );

  // A compliant covenant reading.
  const facility = (await post(ctx.ownerA, `/projects/${projectId}/facilities`, {
    name: "Senior debt facility",
    lender: "Meridian Infrastructure Bank",
    instrument: "loan",
    currency: "GBP",
    committedAmount: 40_000_000,
  })) as unknown as { id: string };
  const covenant = (await post(
    ctx.ownerA,
    `/projects/${projectId}/facilities/${facility.id}/covenants`,
    { name: "Debt service cover ratio", operator: "gte", threshold: 1.2, unit: "x" },
  )) as unknown as { id: string };
  await post(ctx.ownerA, `/projects/${projectId}/covenants/${covenant.id}/readings`, {
    readingDate: today,
    value: 1.42,
  });

  // A lightly used contingency (88% remaining).
  const contingency = (await post(ctx.ownerA, `/projects/${projectId}/contingencies`, {
    name: "Construction contingency",
    amount: 250_000,
    currency: "GBP",
  })) as unknown as { id: string };
  await post(ctx.ownerA, `/projects/${projectId}/contingencies/${contingency.id}/drawdowns`, {
    amount: 30_000,
    reason: "Minor utility diversion",
    drawnAt: today,
  });

  // Two honest vendors with distinct bank accounts (scanned company-wide
  // together with the colluding pair).
  await post(ctx.ownerA, "/entities", {
    kind: "company",
    name: "Osprey Scaffolding Ltd",
    jurisdiction: "GB",
    identifiers: { company_number: "07782341", bank_account: "GB11-CITI-4020-3312-0044-87" },
  });
  await post(ctx.ownerA, "/entities", {
    kind: "company",
    name: "Curlew M&E Services Ltd",
    jurisdiction: "GB",
    identifiers: { company_number: "10904417", bank_account: "GB57-BARC-2201-9976-5410-22" },
  });
}

/* ------------------------------------------------------------------ */
/* Setup: personas + projects, all via the API                         */
/* ------------------------------------------------------------------ */

/** Invite a user into owner A's company via the API and log them in. */
async function inviteAndLogin(name: string, email: string): Promise<Actor> {
  const invited = (await post(ctx.ownerA, "/company/users/invite", {
    email,
    name,
    role: "member",
  })) as unknown as { user: { id: string }; tempPassword: string };
  const login = (await api({ userId: "", headers: {} }, "POST", "/auth/login", {
    email,
    password: invited.tempPassword,
  })) as unknown as { accessToken: string };
  return {
    userId: invited.user.id,
    headers: {
      authorization: `Bearer ${login.accessToken}`,
      "x-company-id": ctx.companyId,
    },
  };
}

async function setup(): Promise<void> {
  const built = await buildTestApp();
  ctx.app = built.app;
  closeApp = built.close;

  // Persona A: registers the company (becomes owner).
  const a = await registerActor(ctx.app, { companyName: "Retrodetect Constructors Ltd" });
  ctx.companyId = a.companyId;
  ctx.ownerA = { userId: a.userId, headers: a.headers };

  // Personas B and R: invited through the directory API, then logged in.
  const stamp = Date.now();
  ctx.memberB = await inviteAndLogin("Site Member B", `member-b-${stamp}@retrodetect.dev`);
  ctx.reviewerR = await inviteAndLogin("Independent Reviewer R", `reviewer-r-${stamp}@retrodetect.dev`);

  // R holds a tenant-wide integrity_reviewer assurance grant.
  await post(ctx.ownerA, "/assurance-grants", {
    userId: ctx.reviewerR.userId,
    role: "integrity_reviewer",
  });

  // Two projects: one seeded with the planted schemes, one clean control.
  const planted = (await post(ctx.ownerA, "/projects", {
    name: "Riverside Interchange (planted)",
    currency: "GBP",
  })) as unknown as { id: string };
  const clean = (await post(ctx.ownerA, "/projects", {
    name: "Harbour Quay (clean control)",
    currency: "GBP",
  })) as unknown as { id: string };
  ctx.plantedProjectId = planted.id;
  ctx.cleanProjectId = clean.id;

  // B gets project_admin membership on both projects.
  for (const projectId of [planted.id, clean.id]) {
    await post(ctx.ownerA, `/projects/${projectId}/memberships`, {
      userId: ctx.memberB.userId,
      templateKey: "project_admin",
    });
  }

  // One executed-form contract per project (FIDIC Red 2017 — its clause
  // library drives the 20.2 notice time bar).
  const mkContract = async (projectId: string) =>
    (await post(ctx.ownerA, `/projects/${projectId}/contracts`, {
      name: "Main Works Contract",
      form: "fidic_red_2017",
      currency: "GBP",
      contractSum: 48_500_000,
    })) as unknown as { id: string };
  ctx.plantedContractId = (await mkContract(planted.id)).id;
  ctx.cleanContractId = (await mkContract(clean.id)).id;
}

/* ------------------------------------------------------------------ */
/* Run + collect                                                       */
/* ------------------------------------------------------------------ */

interface SignalRow {
  id: string;
  projectId: string | null;
  detector: string;
  severity: string;
  title: string;
}

async function runDetectorsAndSweeps(): Promise<void> {
  const r = ctx.reviewerR;
  // Batch detectors over both projects.
  for (const projectId of [ctx.plantedProjectId, ctx.cleanProjectId]) {
    const run = await post(r, `/projects/${projectId}/detectors/run`, {});
    const label = projectId === ctx.plantedProjectId ? "planted" : "clean";
    console.log(`detectors/run (${label}): ${JSON.stringify(run["perDetector"])}`);
  }
  // Entity graph scan (tenant-wide).
  const scan = await post(r, "/entities/scan");
  console.log(
    `entities/scan: ${String(scan["entitiesScanned"])} entities, ` +
      `${String(scan["signalsCreated"])} signal(s)`,
  );
  // Lazy sweeps fire on list reads: contract events (time bars) and payment
  // claims (deemed liability) on both projects.
  await get(r, `/projects/${ctx.plantedProjectId}/contracts/${ctx.plantedContractId}/events`);
  await get(r, `/projects/${ctx.cleanProjectId}/contracts/${ctx.cleanContractId}/events`);
  await get(r, `/projects/${ctx.plantedProjectId}/payment-claims`);
  await get(r, `/projects/${ctx.cleanProjectId}/payment-claims`);
}

async function collectSignals(): Promise<SignalRow[]> {
  const page = (await get(ctx.reviewerR, "/signals?pageSize=200")) as unknown as {
    items: SignalRow[];
    total: number;
  };
  if (page.total > page.items.length) {
    throw new Error(`signal collection truncated: ${page.total} > ${page.items.length}`);
  }
  return page.items;
}

/* ------------------------------------------------------------------ */
/* Scoring                                                             */
/* ------------------------------------------------------------------ */

interface SchemeResult {
  scheme: PlantedScheme;
  caught: boolean;
  signalTitles: string[];
}

function matchesScheme(scheme: PlantedScheme, signal: SignalRow): boolean {
  if (signal.detector !== scheme.expectedDetector) return false;
  return scheme.scope === "company"
    ? signal.projectId === null
    : signal.projectId === ctx.plantedProjectId;
}

function score(signals: SignalRow[]) {
  const results: SchemeResult[] = GROUND_TRUTH.map((scheme) => {
    const matched = signals.filter((s) => matchesScheme(scheme, s));
    return { scheme, caught: matched.length > 0, signalTitles: matched.map((s) => s.title) };
  });

  const attributedIds = new Set<string>();
  for (const signal of signals) {
    if (GROUND_TRUTH.some((scheme) => matchesScheme(scheme, signal))) attributedIds.add(signal.id);
  }
  // False positives: anything on the clean project, plus any signal that no
  // planted scheme accounts for (unexpected detector or scope).
  const cleanFalsePositives = signals.filter((s) => s.projectId === ctx.cleanProjectId);
  const unattributed = signals.filter(
    (s) => !attributedIds.has(s.id) && s.projectId !== ctx.cleanProjectId,
  );

  const caught = results.filter((r) => r.caught).length;
  const precision = signals.length === 0 ? 1 : attributedIds.size / signals.length;
  return { results, caught, precision, cleanFalsePositives, unattributed, totalSignals: signals.length };
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

let closeApp: (() => Promise<void>) | undefined;

async function main(): Promise<number> {
  console.log("Retrospective detection run (spec Vol III §7, synthetic scope)");
  console.log("Booting API against in-memory PGlite...\n");
  await setup();

  console.log(`Planting ${GROUND_TRUTH.length} schemes into the planted project...`);
  for (const scheme of GROUND_TRUTH) {
    await scheme.plant();
    console.log(`  planted: ${scheme.id} (${scheme.specRef})`);
  }

  console.log("\nSeeding the clean control project...");
  await seedCleanControl();

  console.log("\nRunning detectors, entity scan and lazy sweeps...");
  await runDetectorsAndSweeps();

  const signals = await collectSignals();
  const scored = score(signals);

  /* ----- report ----- */
  console.log("\n## Retrospective detection results\n");
  console.log("| Scheme | Detector | Caught | Signal |");
  console.log("| --- | --- | --- | --- |");
  for (const r of scored.results) {
    const title = r.signalTitles[0] ?? "-";
    console.log(
      `| ${r.scheme.name} | ${r.scheme.expectedDetector} | ${r.caught ? "yes" : "NO"} | ${title} |`,
    );
  }
  const fpNames = [
    ...scored.cleanFalsePositives.map((s) => `${s.detector} (clean project)`),
    ...scored.unattributed.map((s) => `${s.detector} (unattributed, project=${s.projectId ?? "company"})`),
  ];
  console.log(
    `\nRecall ${scored.caught}/${GROUND_TRUTH.length}, ` +
      `Precision ${(scored.precision * 100).toFixed(1)}% ` +
      `(${scored.totalSignals - scored.cleanFalsePositives.length - scored.unattributed.length}` +
      `/${scored.totalSignals} signals attributable to planted schemes), ` +
      `false positives: ${fpNames.length === 0 ? "none" : `[${fpNames.join(", ")}]`}`,
  );

  /* ----- JSON artifact (OS tmpdir — the repo stays clean) ----- */
  const reportDir = mkdtempSync(path.join(tmpdir(), "retrodetect-"));
  const reportPath = path.join(reportDir, "retrodetect-report.json");
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        scope: "synthetic seeded project (spec Vol III §7 requires a real known case)",
        recall: { caught: scored.caught, planted: GROUND_TRUTH.length },
        precision: scored.precision,
        totalSignals: scored.totalSignals,
        falsePositives: fpNames,
        schemes: scored.results.map((r) => ({
          id: r.scheme.id,
          name: r.scheme.name,
          specRef: r.scheme.specRef,
          expectedDetector: r.scheme.expectedDetector,
          caught: r.caught,
          signalTitles: r.signalTitles,
        })),
        signals,
      },
      null,
      2,
    ),
  );
  console.log(`\nJSON artifact: ${reportPath}`);

  const ok = scored.caught === GROUND_TRUTH.length && scored.cleanFalsePositives.length === 0;
  if (!ok) {
    console.error(
      "\nFAIL: " +
        (scored.caught < GROUND_TRUTH.length ? "recall below 100%. " : "") +
        (scored.cleanFalsePositives.length > 0 ? "clean project raised signals." : ""),
    );
  }
  return ok ? 0 : 1;
}

try {
  process.exitCode = await main();
} finally {
  await closeApp?.();
}
