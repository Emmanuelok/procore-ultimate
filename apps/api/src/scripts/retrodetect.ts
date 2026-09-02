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
import { entities, entityRelationships, invoices, paymentClaims, vendors } from "@constructos/db";
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
 * The 17 planted schemes.
 *
 * Schemes 1-3 deliberately share one fabricated cost-assertion population: a
 * manually invented payment book is exactly the kind of dataset that trips the
 * round-number, duplicate and Benford detectors at once, and each detector
 * keys on a different signature within it.
 *
 * Schemes 12-14 likewise share one payroll run (see PERIOD below): the same
 * reconciliation pass over employer payroll against the independent
 * site-access stream raises a different detector for each of three workers —
 * one paid with no attendance at all, one billing more days than the gate
 * recorded, one paid materially below the rate on their own contract.
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
  /* ----- Phase 5 (Tier 4 safeguards: Domains J, M, K) ----- */
  {
    id: "ghost_worker",
    name: "Ghost worker (18 days of payroll, zero site-access records)",
    specRef: "Domain M #668-669 (M17 biometric-to-payroll reconciliation)",
    expectedDetector: "ghost_worker",
    scope: "project",
    plant: plantGhostWorker,
  },
  {
    id: "payroll_overclaim",
    name: "Payroll overclaim (22 days claimed against 12 evidenced)",
    specRef: "Domain M #669, #676 (M17 payroll vs access reconciliation)",
    expectedDetector: "payroll_overclaim",
    scope: "project",
    plant: plantPayrollOverclaim,
  },
  {
    id: "wage_underpayment",
    name: "Wage underpayment (paid GBP 210/day against a GBP 300 agreed rate)",
    specRef: "Domain M #677, #682 (M17 wage-versus-hours verification)",
    expectedDetector: "wage_underpayment",
    scope: "project",
    plant: plantWageUnderpayment,
  },
  {
    id: "grievance_sla_breach",
    name: "Grievance SLA breach (critical community grievance 20 days old, unresolved)",
    specRef: "Domain J #569-572 (M16 grievance redress SLA sweep)",
    expectedDetector: "grievance_sla_breach",
    scope: "project",
    plant: plantGrievanceSlaBreach,
  },
  {
    id: "land_blocks_programme",
    name: "Un-acquired land blocking imminent works (parcel identified, task starts in 10 days)",
    specRef: "Domain J #547, #551, #591 (M16 consent-to-programme dependency)",
    expectedDetector: "land_blocks_programme",
    scope: "project",
    plant: plantLandBlocksProgramme,
  },
  {
    id: "permit_expired",
    name: "Lapsed consent (road-closure permit granted, expiry 35 days past)",
    specRef: "Domain J #585-587 (M19 permit register expiry sweep)",
    expectedDetector: "permit_expired",
    scope: "project",
    plant: plantExpiredPermit,
  },
  /* ----- Platform upgrade wave (Domain A payables + network + certification) ----- */
  {
    id: "ghost_vendor_identity",
    name: "Ghost vendor (supplier email is a project contact's email)",
    specRef: "Domain A #53-54",
    expectedDetector: "vendor_person_identity_collision",
    scope: "company",
    plant: plantGhostVendor,
  },
  {
    id: "sequential_invoices",
    name: "Sole-customer shell (four consecutive supplier invoice numbers)",
    specRef: "Domain A #55",
    expectedDetector: "sequential_invoice_numbers",
    scope: "company",
    plant: plantSequentialInvoices,
  },
  {
    id: "duplicate_payment",
    name: "Duplicate settlement (same supplier, same amount, same number, 2 days apart)",
    specRef: "Domain A #60",
    expectedDetector: "duplicate_payment",
    scope: "company",
    plant: plantDuplicatePayment,
  },
  {
    id: "undeclared_conflict",
    name: "Undeclared conflict (approver is a director of the supplier they approve)",
    specRef: "Domain A #45-47",
    expectedDetector: "undeclared_conflict",
    scope: "company",
    plant: plantUndeclaredConflict,
  },
  {
    id: "sanctioned_entity",
    name: "Designated party (entity name matches a screening-list designation)",
    specRef: "Domain A #10, #42-43",
    expectedDetector: "entity_screening_hit",
    scope: "company",
    plant: plantSanctionedEntity,
  },
  {
    id: "backdated_records",
    name: "Backdated entries (assertions dated weeks before they were written)",
    specRef: "Domain A #104",
    expectedDetector: "backdated_record",
    scope: "project",
    plant: plantBackdatedRecords,
  },
  {
    id: "certified_above_evidenced",
    name: "Over-certification (92% claimed against 48% observed by reality capture)",
    specRef: "Domain A #65-71 (typed reconciliation)",
    expectedDetector: "certified_above_evidenced",
    scope: "project",
    plant: plantOverCertifiedProgress,
  },
];

/** The one ghost supplier every payables scheme is planted against. */
const GHOST_VENDOR = {
  name: "Osprey Site Solutions Ltd",
  email: "accounts@osprey-site.example",
  registrationNumber: "13998210",
} as const;

/** Its id, filled in by plantGhostVendor and reused by the later plants. */
let ghostVendorId = "";

/**
 * The single payroll/reconciliation window shared by schemes 12-14 and by the
 * clean control's honest payroll. Fixed once at start-up so the plant phase
 * and the run phase can never disagree about which period is being scored.
 */
const PERIOD = { start: addDaysISO(todayISO(), -27), end: todayISO() };

/** The `n` calendar days immediately before today, most recent first. */
function recentDates(n: number): string[] {
  return Array.from({ length: n }, (_, i) => addDaysISO(todayISO(), -(i + 1)));
}

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
  /** labour supplier employing the workers on each project (M17 rolls risk
   *  up to the EMPLOYER, so every worker needs one) */
  plantedVendorId: string;
  cleanVendorId: string;
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

/* ----- M17 workforce helpers (used by schemes 12-14 and the control) ----- */

/** Enrol one worker on a project's register (#667). */
async function enrolWorker(
  projectId: string,
  vendorId: string,
  worker: { reference: string; fullName: string; trade: string; agreedDailyRate: number },
): Promise<void> {
  await post(ctx.ownerA, `/projects/${projectId}/workers`, {
    ...worker,
    vendorId,
    currency: "GBP",
    idVerified: true,
    biometricEnrolled: true,
    contractIssued: true,
    contractLanguage: "en",
    inductedAt: addDaysISO(todayISO(), -60),
  });
}

/** Push turnstile/biometric access days — the INDEPENDENT evidence stream. */
async function ingestAccess(
  projectId: string,
  workerReference: string,
  dates: string[],
): Promise<void> {
  await post(ctx.ownerA, `/projects/${projectId}/site-access`, {
    records: dates.map((accessDate) => ({
      workerReference,
      accessDate,
      firstIn: "07:00",
      lastOut: "16:30",
      hoursOnSite: 9,
      source: "biometric",
    })),
  });
}

/** Push the employer's own payroll claim for the shared window. */
async function ingestPayroll(
  projectId: string,
  entry: { workerReference: string; daysClaimed: number; grossPay: number; deductions?: number },
): Promise<void> {
  const deductions = entry.deductions ?? 0;
  await post(ctx.ownerA, `/projects/${projectId}/payroll`, {
    entries: [
      {
        workerReference: entry.workerReference,
        periodStart: PERIOD.start,
        periodEnd: PERIOD.end,
        daysClaimed: entry.daysClaimed,
        grossPay: entry.grossPay,
        deductions,
        netPay: Math.round((entry.grossPay - deductions) * 100) / 100,
        currency: "GBP",
        paidAt: PERIOD.end,
      },
    ],
  });
}

/**
 * A schedule with a single works task starting `startsInDays` from today —
 * the thing an un-acquired parcel or an ungranted consent blocks (#591).
 * Returns the task id. A task with no predecessors starts on projectStart.
 */
async function scheduleTaskStartingIn(
  projectId: string,
  startsInDays: number,
  taskName: string,
): Promise<string> {
  const schedule = (await post(ctx.ownerA, `/projects/${projectId}/schedules`, {
    name: "Main works programme",
    projectStart: addDaysISO(todayISO(), startsInDays),
  })) as unknown as { id: string };
  const task = (await post(
    ctx.ownerA,
    `/projects/${projectId}/schedules/${schedule.id}/tasks`,
    { name: taskName, durationDays: 45, wbsCode: "2.1" },
  )) as unknown as { id: string };
  return task.id;
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
/* Phase 5 schemes — Tier 4 safeguards (Domains J, M, K)               */
/* ------------------------------------------------------------------ */

/**
 * Schemes 12-14 — the padded payroll run. All three land in one payroll file
 * for PERIOD, reconciled in the run phase by a single
 * POST /workforce/reconcile. Each worker is shaped to trip exactly one
 * condition of the M17 engine, so the three detectors are separable:
 *
 *   RI-W-101  18 days claimed,  0 access days           -> ghost_worker
 *   RI-W-102  22 days claimed, 12 access days (1.83x)   -> payroll_overclaim
 *   RI-W-103  20 days claimed, 20 access days, GBP 210/day
 *             against a GBP 300 contract rate           -> wage_underpayment
 *
 * Nothing here needs a database write: payroll and gate logs are historical
 * records by nature, and the API accepts past periods and access dates.
 */
async function plantGhostWorker(): Promise<void> {
  // A name on the payroll that the turnstile has never seen. No site-access
  // batch is ingested for this worker at all — that absence IS the scheme.
  await enrolWorker(ctx.plantedProjectId, ctx.plantedVendorId, {
    reference: "RI-W-101",
    fullName: "Ade Okonjo",
    trade: "Steel fixer",
    agreedDailyRate: 300,
  });
  await ingestPayroll(ctx.plantedProjectId, {
    workerReference: "RI-W-101",
    daysClaimed: 18,
    grossPay: 5400,
  });
}

async function plantPayrollOverclaim(): Promise<void> {
  // Billed at the correct rate — so the wage check stays silent — but for ten
  // days the gate log does not support (22 / 12 = 1.83x, tolerance 1.15x).
  await enrolWorker(ctx.plantedProjectId, ctx.plantedVendorId, {
    reference: "RI-W-102",
    fullName: "Tomasz Brzezinski",
    trade: "Formwork carpenter",
    agreedDailyRate: 300,
  });
  await ingestAccess(ctx.plantedProjectId, "RI-W-102", recentDates(12));
  await ingestPayroll(ctx.plantedProjectId, {
    workerReference: "RI-W-102",
    daysClaimed: 22,
    grossPay: 6600,
  });
}

async function plantWageUnderpayment(): Promise<void> {
  // Attendance reconciles exactly (20 claimed, 20 evidenced), so this is not
  // a fraud against the employer — it is wage theft from the worker: GBP 4200
  // for 20 days is GBP 210/day against the GBP 300 on their own contract.
  await enrolWorker(ctx.plantedProjectId, ctx.plantedVendorId, {
    reference: "RI-W-103",
    fullName: "Rukmini Devi",
    trade: "General operative",
    agreedDailyRate: 300,
  });
  await ingestAccess(ctx.plantedProjectId, "RI-W-103", recentDates(20));
  await ingestPayroll(ctx.plantedProjectId, {
    workerReference: "RI-W-103",
    daysClaimed: 20,
    grossPay: 4200,
  });
}

async function plantGrievanceSlaBreach(): Promise<void> {
  // A critical community grievance carries a 7-day resolution SLA. This one
  // was received 20 days ago and never acknowledged or assigned, so it is 13
  // days past its published deadline. The intake API computes the SLA from
  // receivedAt (the date the community raised it, not the keying-in date) and
  // legitimately accepts past dates, so no DB write is needed to age it.
  await post(ctx.ownerA, `/projects/${ctx.plantedProjectId}/grievances`, {
    channel: "community_meeting",
    complainantName: "Mrs A. Nwosu (Riverside Farmers' Association)",
    complainantContact: "+44 7700 900412",
    category: "access",
    severity: "critical",
    description:
      "Haul road diversion at CH 2+800 has cut the only vehicle access to twelve smallholdings; " +
      "produce is spoiling before it reaches market and an ambulance could not reach the hamlet.",
    receivedAt: addDaysISO(todayISO(), -20),
  });
}

async function plantLandBlocksProgramme(): Promise<void> {
  // Embankment works are ten days from starting on a parcel that is still
  // only "identified" — no survey, no negotiation, no title. The dependency
  // is recorded honestly on the parcel; the detector reads it against the
  // programme when the schedule-risk view is opened in the run phase.
  const taskId = await scheduleTaskStartingIn(
    ctx.plantedProjectId,
    10,
    "Embankment construction CH 3+000 to CH 3+800",
  );
  await post(ctx.ownerA, `/projects/${ctx.plantedProjectId}/parcels`, {
    reference: "RI-LP-014",
    description: "Riparian strip east of the interchange, required for the embankment toe",
    areaSqm: 14800,
    tenureType: "customary",
    ownerName: "Nwosu family (customary holding, unregistered)",
    valuationAmount: 268000,
    currency: "GBP",
    blockingTaskIds: [taskId],
  });
}

async function plantExpiredPermit(): Promise<void> {
  // A temporary road-closure consent granted 395 days ago on a 360-day term:
  // it lapsed 35 days ago and nobody renewed it. Recording a historic consent
  // with a past grant and a past expiry is a legitimate API operation (that is
  // how an existing project's permit register is loaded), so this needs no DB
  // write either. The permit deliberately carries NO blockingTaskIds: an
  // expired permit that blocks a task would also — correctly — raise
  // permit_blocks_programme, and this scheme is scored on permit_expired.
  const permit = (await post(ctx.ownerA, `/projects/${ctx.plantedProjectId}/permits`, {
    kind: "road_closure",
    title: "Temporary closure of Riverside Approach for deck erection",
    authority: "Riverside County Highways",
    jurisdiction: "GB-ENG",
    reference: "TTRO/2024/0418",
    appliedAt: addDaysISO(todayISO(), -420),
    expectedDays: 20,
  })) as unknown as { id: string };
  // Granted immediately after application, before any permit list read: the
  // grant discharges the determination obligation, so the determination-
  // overdue sweep never sees this permit awaiting a decision.
  await post(
    ctx.ownerA,
    `/projects/${ctx.plantedProjectId}/permits/${permit.id}/status`,
    {
      status: "granted",
      grantedAt: addDaysISO(todayISO(), -395),
      expiresAt: addDaysISO(todayISO(), -35),
      reference: "TTRO/2024/0418-G",
    },
  );
}

/* ------------------------------------------------------------------ */
/* Domain A payables, network and certification schemes                */
/* ------------------------------------------------------------------ */

/**
 * The ghost supplier: a company whose registered email is the same address as
 * a person the organisation already pays. The vendor and contact registers are
 * written through the API; only `entityId` (which links a vendor to its
 * assurance-layer entity, for the conflict walk) is set directly, because the
 * directory module owns that column and offers no route for it.
 */
async function plantGhostVendor(): Promise<void> {
  const created = (await post(ctx.ownerA, "/vendors", {
    name: GHOST_VENDOR.name,
    tradeCodes: ["groundworks"],
    country: "GB",
    registrationNumber: GHOST_VENDOR.registrationNumber,
    email: GHOST_VENDOR.email,
  })) as unknown as { id: string };
  ghostVendorId = created.id;

  // A project contact using the very same mailbox.
  await post(ctx.ownerA, "/contacts", {
    name: "R. Vance",
    email: GHOST_VENDOR.email,
    company: "Riverside JV",
  });
}

/** Six invoices from the ghost supplier, four of them consecutively numbered. */
async function plantSequentialInvoices(): Promise<void> {
  const amounts = [12_340.5, 9_878.25, 15_002.9, 7_455.6];
  for (const [i, total] of amounts.entries()) {
    await insertGhostInvoice({
      number: 8_100 + i,
      reference: `GV-INV-${8_100 + i}`,
      invoiceNumber: `OSP-${1_001 + i}`,
      total,
      billingDate: addDaysISO(todayISO(), -(40 - i * 5)),
    });
  }
}

/** The same amount, the same supplier number, two days apart. */
async function plantDuplicatePayment(): Promise<void> {
  for (const [i, billingDate] of [
    addDaysISO(todayISO(), -12),
    addDaysISO(todayISO(), -10),
  ].entries()) {
    await insertGhostInvoice({
      number: 8_200 + i,
      reference: `GV-INV-${8_200 + i}`,
      invoiceNumber: "OSP-2010",
      total: 8_412.75,
      billingDate,
    });
  }
}

/**
 * Invoices are written directly rather than through the invoicing API: an
 * invoice there requires a commitment, a schedule of values and a billing
 * period, none of which this scheme is about. The columns the payables
 * detectors read — supplier, number, amount, dates, approver — are all set,
 * which is what makes the plant faithful.
 */
async function insertGhostInvoice(input: {
  number: number;
  reference: string;
  invoiceNumber: string;
  total: number;
  billingDate: string;
}): Promise<void> {
  await ctx.app.db.insert(invoices).values({
    id: `inv_gv_${input.number}`,
    companyId: ctx.companyId,
    projectId: ctx.plantedProjectId,
    kind: "subcontractor_invoice",
    number: input.number,
    reference: input.reference,
    vendorId: ghostVendorId,
    invoiceNumber: input.invoiceNumber,
    currency: "GBP",
    total: input.total,
    subtotal: input.total,
    billingDate: input.billingDate,
    status: "approved",
    approvedBy: ctx.ownerA.userId,
    approvedAt: `${input.billingDate}T10:30:00.000Z`,
    createdBy: ctx.ownerA.userId,
  });
}

/**
 * The approver of every one of the ghost supplier's invoices is also a
 * director of it, and has declared nothing. Mirroring a user into the entity
 * graph (`identifiers.user_id`) is what gives the walk a starting node.
 */
async function plantUndeclaredConflict(): Promise<void> {
  const person = (await post(ctx.ownerA, "/entities", {
    kind: "person",
    name: "A. Kestrel",
    jurisdiction: "GB",
    identifiers: { user_id: ctx.ownerA.userId },
  })) as unknown as { id: string };
  const company = (await post(ctx.ownerA, "/entities", {
    kind: "company",
    name: GHOST_VENDOR.name,
    jurisdiction: "GB",
    identifiers: { company_number: GHOST_VENDOR.registrationNumber },
  })) as unknown as { id: string };
  await post(ctx.ownerA, `/entities/${person.id}/relationships`, {
    toEntityId: company.id,
    kind: "director_of",
    source: "Companies House filing",
    confidence: 1,
  });
  // Link the vendor record to its entity so the conflict walk can join the
  // approval (which names a vendor) to the graph (which names entities).
  await ctx.app.db
    .update(vendors)
    .set({ entityId: company.id })
    .where(eq(vendors.id, ghostVendorId));
}

/** An entity whose name matches a designation on a screening list snapshot. */
async function plantSanctionedEntity(): Promise<void> {
  await post(ctx.ownerA, "/entities", {
    kind: "company",
    name: "Ironvale Construction Services Limited",
    jurisdiction: "GB",
    identifiers: { company_number: "10222118" },
  });
}

/** Four assertions dated weeks before the moment they were written. */
async function plantBackdatedRecords(): Promise<void> {
  for (const daysAgo of [45, 38, 31, 24]) {
    await postAssertion(ctx.ownerA, ctx.plantedProjectId, {
      kind: "quantity",
      value: 410 + daysAgo,
      unit: "m3",
      basis: `late-entered dayworks sheet, week ${daysAgo}`,
      assertedAt: `${addDaysISO(todayISO(), -daysAgo)}T08:00:00Z`,
    });
  }
}

/**
 * 92% claimed; independent reality capture inside the same window observed
 * 48%. The typed reconciler (progress_vs_capture) is what turns that into a
 * finding, and it only counts because the capture came from someone other than
 * the claimant.
 */
async function plantOverCertifiedProgress(): Promise<void> {
  await postAssertion(ctx.ownerA, ctx.plantedProjectId, {
    kind: "progress_percent",
    value: 92,
    unit: "%",
    basis: "interim application 7 — superstructure",
  });
  for (const observed of [47, 48, 49]) {
    await post(ctx.memberB, `/projects/${ctx.plantedProjectId}/evidence`, {
      kind: "reality_capture",
      source: "monthly drone photogrammetry, independent surveyor",
      independenceScore: 0.85,
      metadata: { observedPercent: observed },
    });
  }
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

  /* ----- Phase 5 controls (Domains J, M, K) ----- */

  // Three honest workers over the SAME payroll window as schemes 12-14, each
  // sitting just inside a different tolerance of the M17 engine — the control
  // that proves the detectors key on the breach, not on the shape of the data:
  //   HQ-W-201  20 claimed / 20 evidenced, paid the agreed rate exactly
  //   HQ-W-202  18 claimed / 17 evidenced (1.06x — one manual gate-log gap,
  //             inside the 1.15x overclaim tolerance)
  //   HQ-W-203  15 claimed / 15 evidenced at GBP 312 against a GBP 320
  //             agreed rate (0.975x — a part-day at the period edge, inside
  //             the 0.95x underpayment tolerance), with a lawful deduction
  const honest = [
    { reference: "HQ-W-201", fullName: "Grace Adeyemi", trade: "Steel fixer", rate: 300, claimed: 20, access: 20, gross: 6000, deductions: 0 },
    { reference: "HQ-W-202", fullName: "Michal Nowak", trade: "Formwork carpenter", rate: 280, claimed: 18, access: 17, gross: 5040, deductions: 0 },
    { reference: "HQ-W-203", fullName: "Priya Raman", trade: "General operative", rate: 320, claimed: 15, access: 15, gross: 4680, deductions: 468 },
  ];
  for (const w of honest) {
    await enrolWorker(projectId, ctx.cleanVendorId, {
      reference: w.reference,
      fullName: w.fullName,
      trade: w.trade,
      agreedDailyRate: w.rate,
    });
    await ingestAccess(projectId, w.reference, recentDates(w.access));
    await ingestPayroll(projectId, {
      workerReference: w.reference,
      daysClaimed: w.claimed,
      grossPay: w.gross,
      deductions: w.deductions,
    });
  }

  // A critical grievance (same 7-day SLA as the planted one) received three
  // days ago, acknowledged, resolved and closed WITH the complainant — the
  // full #572-573 ladder, well inside its deadline.
  const settled = (await post(ctx.ownerA, `/projects/${projectId}/grievances`, {
    channel: "in_person",
    complainantName: "Mr K. Whitlock",
    complainantContact: "k.whitlock@example.org",
    category: "access",
    severity: "critical",
    description: "Quay Lane pedestrian route closed without notice; school run blocked.",
    receivedAt: addDaysISO(today, -3),
  })) as unknown as { id: string };
  await post(ctx.ownerA, `/projects/${projectId}/grievances/${settled.id}/acknowledge`, {
    note: "Acknowledged by the community liaison officer on the day of receipt.",
  });
  await post(ctx.ownerA, `/projects/${projectId}/grievances/${settled.id}/assign`, {
    assigneeId: ctx.memberB.userId,
  });
  await post(ctx.ownerA, `/projects/${projectId}/grievances/${settled.id}/resolve`, {
    resolution: "Signed pedestrian diversion installed via Harbour Street; route reopened.",
  });
  await post(ctx.ownerA, `/projects/${projectId}/grievances/${settled.id}/verify-closure`, {
    complainantSatisfied: true,
    note: "Complainant walked the diversion with the CLO and confirmed it works.",
  });

  // An OPEN grievance still inside its SLA — the harder control: the sweep
  // must look at the deadline, not merely at whether a grievance is open.
  await post(ctx.ownerA, `/projects/${projectId}/grievances`, {
    channel: "phone",
    category: "dust",
    severity: "medium",
    description: "Dust from the haul road settling on washing lines at Quay Cottages.",
    receivedAt: addDaysISO(today, -4),
  });

  // A parcel blocking works that start in 14 days — but taken all the way
  // through survey, negotiation, EVIDENCED compensation and title transfer,
  // so the project actually holds the land. Acquired parcels drop out of the
  // schedule-risk population entirely.
  const cleanTaskId = await scheduleTaskStartingIn(
    projectId,
    14,
    "Bridge pier 3 excavation and blinding",
  );
  const parcel = (await post(ctx.ownerA, `/projects/${projectId}/parcels`, {
    reference: "HQ-LP-007",
    description: "Quayside yard required for the pier 3 working platform",
    areaSqm: 9200,
    tenureType: "freehold",
    ownerName: "Harbour Quay Estates Ltd",
    valuationAmount: 415000,
    currency: "GBP",
    blockingTaskIds: [cleanTaskId],
  })) as unknown as { id: string };
  for (const status of ["surveyed", "under_negotiation"]) {
    await post(ctx.ownerA, `/projects/${projectId}/parcels/${parcel.id}/status`, { status });
  }
  const payment = (await post(ctx.ownerA, `/projects/${projectId}/evidence`, {
    kind: "bank_transaction",
    source: "Beneficiary-verified CHAPS confirmation, Harbour Quay Estates Ltd",
    independenceScore: 0.9,
    metadata: { amount: 415000, currency: "GBP", reference: "CHAPS/HQ/0442" },
  })) as unknown as { id: string };
  await post(ctx.ownerA, `/projects/${projectId}/parcels/${parcel.id}/compensate`, {
    amount: 415000,
    paidAt: addDaysISO(today, -21),
    evidenceIds: [payment.id],
    note: "Compensation at valuation, paid to the registered proprietor.",
  });
  await post(ctx.ownerA, `/projects/${projectId}/parcels/${parcel.id}/status`, {
    status: "acquired",
    note: "Transfer registered; possession taken.",
  });

  // A granted, in-date consent: applied 20 days ago inside its determination
  // period, granted 5 days ago, valid for another year.
  const permit = (await post(ctx.ownerA, `/projects/${projectId}/permits`, {
    kind: "road_closure",
    title: "Temporary closure of Quay Lane for pier 3 deliveries",
    authority: "Harbour Borough Highways",
    jurisdiction: "GB-ENG",
    appliedAt: addDaysISO(today, -20),
    expectedDays: 30,
  })) as unknown as { id: string };
  await post(ctx.ownerA, `/projects/${projectId}/permits/${permit.id}/status`, {
    status: "granted",
    grantedAt: addDaysISO(today, -5),
    expiresAt: addDaysISO(today, 360),
    reference: "TTRO/2026/0119-G",
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

  // One labour supplier per project. M17 attaches modern-slavery exposure to
  // the EMPLOYER, so a worker without a vendor would be unattributable.
  const mkVendor = async (name: string, registrationNumber: string) =>
    (await post(ctx.ownerA, "/vendors", {
      name,
      tradeCodes: ["labour_supply"],
      country: "GB",
      registrationNumber,
    })) as unknown as { id: string };
  ctx.plantedVendorId = (await mkVendor("Kestrel Labour Supply Ltd", "12447801")).id;
  ctx.cleanVendorId = (await mkVendor("Heron Site Services Ltd", "09338152")).id;
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
  // Typed auto-reconciliation over every unreconciled assertion, on BOTH
  // projects: the pass that tests a claim against the whole evidence pool
  // rather than against whatever the claimant chose to attach.
  for (const projectId of [ctx.plantedProjectId, ctx.cleanProjectId]) {
    const auto = await post(ctx.ownerA, `/projects/${projectId}/reconciliations/auto`, {});
    const label = projectId === ctx.plantedProjectId ? "planted" : "clean";
    console.log(
      `reconciliations/auto (${label}): ${String(auto["created"])} reconciliation(s), ` +
        `${String(auto["signalsCreated"])} signal(s)`,
    );
  }
  // Entity graph scan (tenant-wide).
  const scan = await post(r, "/entities/scan");
  console.log(
    `entities/scan: ${String(scan["entitiesScanned"])} entities, ` +
      `${String(scan["signalsCreated"])} signal(s)`,
  );
  // Screening every entity against the configured list snapshots. This
  // deployment ships fixtures, and every result names the snapshot it used.
  const screened = await post(ctx.ownerA, "/entities/screen", {});
  console.log(
    `entities/screen: ${String(screened["screened"])} entity/entities, ` +
      `${String(screened["withMatches"])} with matches`,
  );
  /*
   * The company-scoped detector programme, run with an EXPLICIT detector list.
   *
   * The harness measures precision, so it must not run detectors it has
   * planted nothing for: an unplanted detector firing on incidental harness
   * data would be scored as a false positive and would say nothing about the
   * detector's real precision. The full company suite is exercised by the
   * module's own tests; here we score the schemes we planted.
   */
  const company = await post(ctx.ownerA, "/detectors/run", {
    detectors: [
      "vendor_person_identity_collision",
      "sequential_invoice_numbers",
      "duplicate_payment",
      "undeclared_conflict",
    ],
  });
  console.log(
    `detectors/run (company): ${JSON.stringify(company["perDetector"])} ` +
      `skipped=${JSON.stringify(company["skipped"])}`,
  );
  // The M17 payroll reconciliation is an operational (standard-level) route,
  // not a read: an assurance grant is read-only by design, so the reviewer
  // cannot run it — the operator does, and the reviewer reads the signals it
  // raises. Run over the SAME window on both projects.
  for (const projectId of [ctx.plantedProjectId, ctx.cleanProjectId]) {
    const rec = (await post(ctx.ownerA, `/projects/${projectId}/workforce/reconcile`, {
      periodStart: PERIOD.start,
      periodEnd: PERIOD.end,
    })) as unknown as {
      workers: number;
      ghosts: number;
      overclaims: number;
      underpayments: number;
      signalsRaised: number;
    };
    const label = projectId === ctx.plantedProjectId ? "planted" : "clean";
    console.log(
      `workforce/reconcile (${label}): ${rec.workers} worker(s), ${rec.ghosts} ghost(s), ` +
        `${rec.overclaims} overclaim(s), ${rec.underpayments} underpayment(s), ` +
        `${rec.signalsRaised} signal(s)`,
    );
  }
  // Lazy sweeps fire on list reads: contract events (time bars), payment
  // claims (deemed liability), grievances (GRM SLA breach), land schedule
  // risk (un-acquired land blocking works) and permits (lapsed consents,
  // overdue determinations). Every one is hit on BOTH projects.
  for (const [projectId, contractId] of [
    [ctx.plantedProjectId, ctx.plantedContractId],
    [ctx.cleanProjectId, ctx.cleanContractId],
  ] as const) {
    await get(r, `/projects/${projectId}/contracts/${contractId}/events`);
    await get(r, `/projects/${projectId}/payment-claims`);
    await get(r, `/projects/${projectId}/grievances`);
    await get(r, `/projects/${projectId}/land/schedule-risk`);
    await get(r, `/projects/${projectId}/permits`);
  }
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
