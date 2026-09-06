/**
 * ONE EXECUTED TEST PER FLEET AGENT.
 *
 * agents.test.ts covers the governance layer (policy, budget, queue,
 * rollback, visibility) through four agents. This file covers the other
 * twelve — the ones whose `gather()` is 40–120 lines of hand-written
 * multi-table drizzle and whose `propose()` maps model JSON onto a proposal.
 * Registry metadata assertions do not exercise either: before this file,
 * anomaly_explainer — the only fleet agent that produces an OPERATIONAL
 * target type, mutating `signals.explanation` on approval — had never been
 * run end to end.
 *
 * Every test here seeds the real rows the agent reads, asserts the seeded
 * ids actually reached the model (so a wrong column in gather() fails
 * loudly rather than silently narrowing the evidence), and asserts the
 * proposal it queued.
 *
 * It also covers the two authorisation controls the runner gained:
 *   · `requiredTools` — the tools that own the tables the agent reads, so
 *     an ai:standard / budget:none member cannot launder budget figures
 *     into ai_runs.prompt through the cost forecaster;
 *   · `allowedRoles` — the per-kind role limit that used to save, ledger and
 *     render without restricting anything.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import {
  agentActions,
  aiReviewQueue,
  aiRuns,
  assertions,
  bidPackages,
  bidSubmissionLines,
  bidSubmissions,
  budgetLineItems,
  budgets,
  changeEvents,
  commitments,
  companyMemberships,
  contractEvents,
  contracts,
  comments,
  dailyLogs,
  delayEvents,
  drawingRevisions,
  drawingSets,
  drawingSheets,
  evidence,
  forensicClaims,
  ledgerEntries,
  meetingActionItems,
  meetingAgendaItems,
  meetings,
  photos,
  files,
  projectMemberships,
  projects,
  reconciliations,
  rfis,
  safetyIncidents,
  signals,
  specSectionRevisions,
  specSections,
  submittals,
} from "@constructos/db";
import { buildTestApp, registerActor, type TestActor } from "../../test/helpers.js";
import type { BuiltApp } from "../../app.js";
import { newId } from "../../lib/ids.js";
import { setAiClientFactory, type AiClientLike, type AiRequest } from "./service.js";

/* ------------------------------------------------------------------ */
/* The fake model                                                      */
/* ------------------------------------------------------------------ */

let nextText = "{}";
let lastRequest: AiRequest | null = null;
let callCount = 0;

function setResponse(json: unknown): void {
  nextText = typeof json === "string" ? json : JSON.stringify(json);
}

/** Everything the model was actually given, as one string. */
function promptText(): string {
  if (!lastRequest) return "";
  const parts: string[] = [String(lastRequest.system ?? "")];
  for (const msg of lastRequest.messages ?? []) {
    const content = (msg as { content: unknown }).content;
    if (typeof content === "string") parts.push(content);
    else if (Array.isArray(content)) {
      for (const block of content) {
        const b = block as { type?: string; text?: string };
        if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
      }
    }
  }
  return parts.join("\n");
}

const fakeClient: AiClientLike = {
  beta: {
    messages: {
      async create(params: AiRequest) {
        lastRequest = params;
        callCount += 1;
        return {
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: params.model,
          content: [{ type: "text", text: nextText, citations: null }],
          stop_reason: "end_turn",
          stop_sequence: null,
          stop_details: null,
          usage: {
            input_tokens: 120,
            output_tokens: 60,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
            server_tool_use: null,
            service_tier: null,
          },
        } as unknown as Anthropic.Beta.BetaMessage;
      },
    },
  },
};

/* ------------------------------------------------------------------ */
/* Fixtures — one project carrying a row for every agent under test    */
/* ------------------------------------------------------------------ */

let built: BuiltApp;
let owner: TestActor;
let projectId: string;

/** A member with ai:standard on the project but NO budget / bidding / safety. */
let narrow: TestActor;
let narrowHeaders: Record<string, string>;

const ids = {
  contract: "",
  contractEvent: "",
  claim: "",
  delayEvent: "",
  assertion: "",
  evidence: "",
  reconciliation: "",
  signal: "",
  dailyLog: "",
  rfi: "",
  sheet: "",
  specSection: "",
  submittal: "",
  meeting: "",
  agendaItem: "",
  actionItem: "",
  incident: "",
  changeEvent: "",
  budgetLine: "",
  commitment: "",
  bidPackage: "",
  bidA: "",
  bidB: "",
  photo: "",
  photoFile: "",
};

beforeAll(async () => {
  built = await buildTestApp();
  built.app.appConfig.ANTHROPIC_API_KEY = "test-key-not-a-real-key";
  setAiClientFactory(() => fakeClient);

  owner = await registerActor(built.app);
  const db = built.app.db;
  const companyId = owner.companyId;
  const by = owner.userId;

  projectId = newId("prj");
  await db.insert(projects).values({
    id: projectId,
    companyId,
    name: "Fleet Test Works",
    stage: "course_of_construction",
  });

  narrow = await registerActor(built.app);
  await db.insert(companyMemberships).values({
    id: newId("cm"),
    companyId,
    userId: narrow.userId,
    role: "member",
  });
  await db.insert(projectMemberships).values({
    id: newId("pm"),
    companyId,
    projectId,
    userId: narrow.userId,
    templateKey: "read_only",
    // read_only grants read on everything; these are the denials that matter.
    // assurance is "none" in the read_only template; the anomaly explainer
    // needs it, so it is granted explicitly — the denials under test are the
    // three below it.
    overrides: {
      ai: "standard",
      assurance: "read",
      budget: "none",
      bidding: "none",
      safety: "none",
    },
  });
  narrowHeaders = {
    authorization: narrow.headers["authorization"]!,
    "x-company-id": companyId,
  };

  /* ---- contract + contract event (time-bar drafter) ---- */
  ids.contract = newId("con");
  await db.insert(contracts).values({
    id: ids.contract,
    companyId,
    projectId,
    name: "Main works contract",
    form: "nec4",
    necOption: "C",
    currency: "GBP",
    particularConditions: { "61.3": "Notice period 8 weeks" },
    status: "executed",
    createdBy: by,
  });
  ids.contractEvent = newId("cev");
  await db.insert(contractEvents).values({
    id: ids.contractEvent,
    companyId,
    projectId,
    contractId: ids.contract,
    number: 41,
    kind: "compensation_event",
    clauseRef: "60.1(1)",
    title: "Instruction changing the works information",
    description: "The Project Manager instructed a change to the piling layout.",
    eventDate: "2026-07-01",
    noticeDeadline: "2026-08-26",
    status: "open",
    raisedBy: by,
  });

  /* ---- forensic claim + delay event (claim narrative, rebuttal) ---- */
  ids.delayEvent = newId("dly");
  await db.insert(delayEvents).values({
    id: ids.delayEvent,
    companyId,
    projectId,
    number: 7,
    title: "Piling rig stood down awaiting the revised layout",
    description: "Rig idle from 2026-07-02 to 2026-07-16.",
    cause: "employer_change",
    excusable: 1,
    compensable: 1,
    status: "open",
    startDate: "2026-07-02",
    durationDays: 14,
    raisedBy: by,
  });
  ids.claim = newId("fcl");
  await db.insert(forensicClaims).values({
    id: ids.claim,
    companyId,
    projectId,
    number: 3,
    title: "Extension of time — revised piling layout",
    kind: "eot",
    status: "draft",
    clauseRef: "60.1(1)",
    delayEventIds: [ids.delayEvent],
    daysClaimed: 14,
    amountClaimed: 92_000,
    currency: "GBP",
    chronology: [{ at: "2026-07-02", what: "Rig stood down" }],
    createdBy: by,
  });

  /* ---- assurance rows (evidence scorer, counterfactual) ---- */
  ids.assertion = newId("asrt");
  await db.insert(assertions).values({
    id: ids.assertion,
    companyId,
    projectId,
    kind: "progress",
    claimantId: "ven_piling",
    claimantKind: "entity",
    value: 62,
    unit: "percent",
    basis: "Subcontractor's monthly application",
    assertedAt: "2026-07-31T00:00:00.000Z",
    createdBy: by,
  });
  ids.evidence = newId("evd");
  await db.insert(evidence).values({
    id: ids.evidence,
    companyId,
    projectId,
    kind: "photo",
    source: "ven_piling",
    contentHash: "a".repeat(64),
    capturedAt: "2026-07-31T00:00:00.000Z",
    independenceScore: 0.1,
    provenance: { submittedBy: "ven_piling" },
    submittedBy: "ven_piling",
  });
  ids.reconciliation = newId("rec");
  await db.insert(reconciliations).values({
    id: ids.reconciliation,
    companyId,
    projectId,
    assertionId: ids.assertion,
    evidenceIds: [ids.evidence],
    method: "progress",
    result: "variance",
    variance: -11,
    variancePercent: -17.7,
    confidence: 0.55,
    disposition: "open",
    notes: "Observed progress below the certified figure.",
    createdBy: by,
  });
  ids.signal = newId("sig");
  await db.insert(signals).values({
    id: ids.signal,
    companyId,
    projectId,
    detector: "progress_vs_observed",
    severity: "high",
    confidence: 0.7,
    title: "Certified progress exceeds observed progress",
    explanation: "Certified 62% against an observed 51% on the same date.",
    evidenceRefs: [{ type: "reconciliation", id: ids.reconciliation }],
    disposition: "new",
  });

  /* ---- field rows (rebuttal, multi-document reasoner) ---- */
  ids.dailyLog = newId("dlog");
  await db.insert(dailyLogs).values({
    id: ids.dailyLog,
    companyId,
    projectId,
    logDate: "2026-07-08",
    status: "submitted",
    notes: "Piling rig working the south sector; no stoppage recorded.",
    sections: { labour: [{ trade: "piling", count: 6 }] },
    createdBy: by,
  });
  ids.rfi = newId("rfi");
  await db.insert(rfis).values({
    id: ids.rfi,
    companyId,
    projectId,
    number: 88,
    subject: "Piling layout clash at grid C4",
    question: "Which piling layout governs at grid C4?",
    officialResponse: "The revised layout on S-201 rev C governs.",
    status: "answered",
    respondedAt: "2026-07-10T00:00:00.000Z",
    createdBy: by,
  });

  const drawingSetId = newId("dset");
  await db.insert(drawingSets).values({
    id: drawingSetId,
    companyId,
    projectId,
    name: "Construction issue",
    processing: "done",
    uploadedBy: by,
  });
  ids.sheet = newId("shd");
  await db.insert(drawingSheets).values({
    id: ids.sheet,
    companyId,
    projectId,
    number: "S-201",
    title: "Piling layout",
    discipline: "structural",
  });
  await db.insert(drawingRevisions).values({
    id: newId("drv"),
    sheetId: ids.sheet,
    setId: drawingSetId,
    revision: "C",
    fileId: newId("fil"),
    extractedText: "PILING LAYOUT: pile caps at grid C4 to be 900mm deep.",
    isSuperseded: 0,
    uploadedBy: by,
  });

  /* ---- specification + submittal (spec compliance) ---- */
  ids.specSection = newId("spc");
  const specRevisionId = newId("spr");
  await db.insert(specSections).values({
    id: ids.specSection,
    companyId,
    projectId,
    code: "31 62 16",
    normalisedCode: "316216",
    // "piling" appears in the title so the multi-document reasoner's ILIKE
    // over spec titles matches the same question the drawing text does.
    title: "Steel piling",
    divisionCode: "31",
    createdBy: by,
  });
  await db.insert(specSectionRevisions).values({
    id: specRevisionId,
    companyId,
    projectId,
    sectionId: ids.specSection,
    bookId: newId("sbk"),
    revision: "1",
    revisionOrdinal: 1,
    fileId: newId("fil"),
    extractedText:
      "2.1 PILE CAPS. Pile caps at grid C4 shall be 900mm deep minimum and cast in C40/50 concrete.",
    createdBy: by,
  });
  await db
    .update(specSections)
    .set({ currentRevisionId: specRevisionId })
    .where(eq(specSections.id, ids.specSection));

  ids.submittal = newId("sub");
  await db.insert(submittals).values({
    id: ids.submittal,
    companyId,
    projectId,
    number: 55,
    revision: 0,
    title: "Steel pile shop drawings",
    specSection: "31 62 16",
    submittalType: "shop_drawing",
    status: "in_review",
    createdBy: by,
  });

  /* ---- meeting (minutes drafter) ---- */
  ids.meeting = newId("mtg");
  await db.insert(meetings).values({
    id: ids.meeting,
    companyId,
    projectId,
    number: 12,
    reference: "PM-012",
    title: "Progress meeting 12",
    meetingType: "progress",
    status: "held",
    scheduledStart: "2026-07-15T09:00:00.000Z",
    attendeeCount: 8,
    createdBy: by,
  });
  ids.agendaItem = newId("mai");
  await db.insert(meetingAgendaItems).values({
    id: ids.agendaItem,
    companyId,
    projectId,
    meetingId: ids.meeting,
    itemNumber: "3.1",
    position: 1,
    title: "Piling progress",
    description: "Review of the piling sequence following the layout change.",
    discussion: "Contractor reported 14 days lost. PM asked for the records.",
    status: "open",
    createdBy: by,
  });
  ids.actionItem = newId("mact");
  await db.insert(meetingActionItems).values({
    id: ids.actionItem,
    companyId,
    projectId,
    meetingId: ids.meeting,
    agendaItemId: ids.agendaItem,
    number: 1,
    reference: "PM-012-A1",
    title: "Issue the piling records to the PM",
    status: "open",
    ownerName: "Site manager",
    dueDate: "2026-07-22",
    createdBy: by,
  });

  /* ---- safety incident (incident classifier) ---- */
  ids.incident = newId("inc");
  await db.insert(safetyIncidents).values({
    id: ids.incident,
    companyId,
    projectId,
    number: 4,
    reference: "INC-004",
    incidentType: "injury",
    severity: "serious",
    title: "Operative struck by swinging load",
    description: "An operative was struck on the forearm by a swinging pile section.",
    occurredAt: "2026-07-20T10:15:00.000Z",
    reportedAt: "2026-07-20T11:00:00.000Z",
    treatmentLevel: "hospital",
    bodyPart: "arm",
    isLostTime: 1,
    lostTimeDays: 9,
    mechanism: "struck_by",
    createdBy: by,
  });

  /* ---- financial rows (change impact) ---- */
  ids.changeEvent = newId("chg");
  await db.insert(changeEvents).values({
    id: ids.changeEvent,
    companyId,
    projectId,
    number: 9,
    reference: "CE-009",
    title: "Revised piling layout",
    description: "Additional piles at grid C4 following the layout change.",
    status: "open",
    estimatedCost: 118_000,
    scheduleImpactDays: 14,
    createdBy: by,
  });
  const budgetId = newId("bud");
  await db.insert(budgets).values({
    id: budgetId,
    companyId,
    projectId,
    number: 1,
    reference: "BUD-001",
    name: "Approved budget",
    status: "approved",
    isActive: 1,
    currency: "GBP",
    createdBy: by,
  });
  ids.budgetLine = newId("bli");
  await db.insert(budgetLineItems).values({
    id: ids.budgetLine,
    budgetId,
    companyId,
    projectId,
    costCode: "02-300",
    description: "Piling",
    originalBudget: 1_200_000,
    revisedBudget: 1_318_000,
    committedCost: 1_100_000,
    jobToDateCosts: 640_000,
    createdBy: by,
  });
  ids.commitment = newId("cmt");
  await db.insert(commitments).values({
    id: ids.commitment,
    companyId,
    projectId,
    number: 5,
    reference: "SC-005",
    title: "Piling subcontract",
    kind: "subcontract",
    status: "executed",
    currency: "GBP",
    originalCommitmentSum: 1_100_000,
    revisedCommitmentSum: 1_100_000,
    createdBy: by,
  });

  /* ---- bidding rows (bid levelling) ---- */
  ids.bidPackage = newId("bpk");
  await db.insert(bidPackages).values({
    id: ids.bidPackage,
    companyId,
    projectId,
    number: 2,
    reference: "BP-002",
    title: "Piling package",
    scopeDescription: "Supply and install steel piles to S-201 rev C.",
    status: "under_evaluation",
    currency: "GBP",
    engineersEstimate: 1_150_000,
    createdBy: by,
  });
  ids.bidA = newId("bsm");
  ids.bidB = newId("bsm");
  await built.app.db.insert(bidSubmissions).values([
    {
      id: ids.bidA,
      companyId,
      projectId,
      packageId: ids.bidPackage,
      vendorId: "ven_a",
      reference: "BP-002-A",
      status: "submitted",
      baseBidAmount: 1_090_000,
      totalAmount: 1_090_000,
      currency: "GBP",
      exclusions: "Excludes disposal of arisings.",
      proposedProgrammeWeeks: 18,
    },
    {
      id: ids.bidB,
      companyId,
      projectId,
      packageId: ids.bidPackage,
      vendorId: "ven_b",
      reference: "BP-002-B",
      status: "submitted",
      baseBidAmount: 1_240_000,
      totalAmount: 1_240_000,
      currency: "GBP",
      exclusions: "None.",
      proposedProgrammeWeeks: 22,
    },
  ]);
  await db.insert(bidSubmissionLines).values([
    {
      id: newId("bsl"),
      companyId,
      projectId,
      submissionId: ids.bidA,
      packageId: ids.bidPackage,
      vendorId: "ven_a",
      position: 1,
      itemCode: "P-100",
      description: "600mm steel pile, supply and drive",
      unit: "m",
      quantity: 4200,
      unitRate: 180,
      amount: 756_000,
      currency: "GBP",
    },
    {
      id: newId("bsl"),
      companyId,
      projectId,
      submissionId: ids.bidB,
      packageId: ids.bidPackage,
      vendorId: "ven_b",
      position: 1,
      itemCode: "P-100",
      description: "600mm steel pile, supply and drive",
      unit: "m",
      quantity: 4200,
      unitRate: 245,
      amount: 1_029_000,
      currency: "GBP",
    },
  ]);

  /* ---- a real stored image (photo intelligence) ---- */
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const saved = await built.app.storage.saveBuffer(companyId, png);
  ids.photoFile = newId("fil");
  await db.insert(files).values({
    id: ids.photoFile,
    companyId,
    projectId,
    name: "pile-cap.png",
    contentType: "image/png",
    sizeBytes: saved.sizeBytes,
    sha256: saved.sha256,
    storageKey: saved.storageKey,
    uploadedBy: by,
  });
  ids.photo = newId("pho");
  await db.insert(photos).values({
    id: ids.photo,
    companyId,
    projectId,
    fileId: ids.photoFile,
    caption: "Pile cap reinforcement at grid C4",
    aiTags: ["existing-tag"],
    aiSummary: "Set by the field team.",
    uploadedBy: by,
  });
});

afterAll(async () => {
  setAiClientFactory(null);
  await built.close();
});

afterEach(() => {
  nextText = "{}";
});

async function run(
  kind: string,
  params: Record<string, unknown> = {},
  headers = owner.headers,
) {
  return built.app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/agents/${kind}/run`,
    headers,
    payload: { params },
  });
}

/** The single proposal a run queued, read straight from the queue. */
async function queued(reviewId: string) {
  const [row] = await built.app.db
    .select()
    .from(aiReviewQueue)
    .where(eq(aiReviewQueue.id, reviewId))
    .limit(1);
  return row!;
}

const CITE = (type: string, id: string) => ({ type, id });

/* ================================================================== */
/* One executed test per previously-untested fleet agent               */
/* ================================================================== */

describe("contract fleet agents", () => {
  it("time_bar_notice_drafter reads the event, the contract and the logs, and drafts a notice", async () => {
    setResponse({
      subject: "Notice of a compensation event — clause 60.1(1)",
      noticeText: "We give notice under clause 61.3 of the instruction of 1 July 2026.",
      clauseRef: "61.3",
      deadline: "2026-08-26",
      urgency: "soon",
      missingFacts: ["The date the instruction was received in writing"],
      citations: [CITE("contract_event", ids.contractEvent), CITE("contract", ids.contract)],
      confidence: 0.72,
    });
    const res = await run("time_bar_notice_drafter", { contractEventId: ids.contractEvent });
    expect(res.statusCode).toBe(201);
    const prompt = promptText();
    expect(prompt).toContain(`type=contract_event id=${ids.contractEvent}`);
    expect(prompt).toContain(`type=contract id=${ids.contract}`);
    expect(prompt).toContain("Notice period 8 weeks");

    const body = res.json() as { reviewIds: string[]; queued: number };
    expect(body.queued).toBe(1);
    const row = await queued(body.reviewIds[0]!);
    expect(row.targetType).toBe("notice_draft");
    expect(row.targetId).toBe(ids.contractEvent);
    expect((row.proposal as Record<string, unknown>)["urgency"]).toBe("soon");
  });

  it("claim_narrative_drafter reads the claim and its delay events", async () => {
    setResponse({
      narrative: "The Project Manager instructed a change on 1 July 2026; the rig stood down.",
      headsOfClaim: [
        { head: "Prolongation", basis: "14 days of rig standing time", supported: true },
        { head: "Loss of productivity", basis: "No measured-mile data recorded", supported: false },
      ],
      gaps: ["Contemporaneous plant records for the standing period"],
      citations: [CITE("forensic_claim", ids.claim), CITE("delay_event", ids.delayEvent)],
      confidence: 0.66,
    });
    const res = await run("claim_narrative_drafter", { claimId: ids.claim });
    expect(res.statusCode).toBe(201);
    const prompt = promptText();
    expect(prompt).toContain(`type=forensic_claim id=${ids.claim}`);
    expect(prompt).toContain(`type=delay_event id=${ids.delayEvent}`);

    const row = await queued((res.json() as { reviewIds: string[] }).reviewIds[0]!);
    expect(row.targetType).toBe("claim_narrative");
    expect(row.targetId).toBe(ids.claim);
    expect(row.summary).toContain("2 head(s)");
  });

  it("rebuttal_finder reads the claim against the daily logs and RFIs that could contradict it", async () => {
    setResponse({
      rebuttals: [
        {
          assertion: "The rig stood down for 14 days from 2 July",
          contradiction: "The daily log for 8 July records the piling rig working the south sector.",
          strength: "strong",
          citations: [CITE("daily_log", ids.dailyLog)],
        },
      ],
      unchallenged: ["That the instruction was issued on 1 July"],
      citations: [CITE("forensic_claim", ids.claim), CITE("daily_log", ids.dailyLog)],
      confidence: 0.7,
    });
    const res = await run("rebuttal_finder", { claimId: ids.claim });
    expect(res.statusCode).toBe(201);
    const prompt = promptText();
    expect(prompt).toContain(`type=daily_log id=${ids.dailyLog}`);
    expect(prompt).toContain(`type=rfi id=${ids.rfi}`);

    const row = await queued((res.json() as { reviewIds: string[] }).reviewIds[0]!);
    expect(row.targetType).toBe("rebuttal");
    expect(row.targetId).toBe(ids.claim);
    expect(row.summary).toContain("1 contradiction(s)");
  });
});

describe("assurance fleet agents", () => {
  it("evidence_sufficiency_scorer reads assertions, reconciliations and their evidence", async () => {
    setResponse({
      assessments: [
        {
          assertionId: ids.assertion,
          sufficiency: "insufficient",
          independenceConcern: true,
          missingEvidence: ["An independent progress observation"],
          rationale: "The only evidence was submitted by the claimant.",
          citations: [CITE("assertion", ids.assertion), CITE("evidence", ids.evidence)],
        },
      ],
      citations: [CITE("assertion", ids.assertion)],
      confidence: 0.8,
    });
    const res = await run("evidence_sufficiency_scorer");
    expect(res.statusCode).toBe(201);
    const prompt = promptText();
    expect(prompt).toContain(`type=assertion id=${ids.assertion}`);
    expect(prompt).toContain(`type=reconciliation id=${ids.reconciliation}`);
    expect(prompt).toContain(`type=evidence id=${ids.evidence}`);

    const body = res.json() as { reviewIds: string[]; signals: number };
    // independenceConcern on a weak assessment raises a signal
    expect(body.signals).toBe(1);
    const row = await queued(body.reviewIds[0]!);
    expect(row.targetType).toBe("evidence_assessment");
    expect(row.targetId).toBeNull();
  });

  it("counterfactual_analyst puts the proposition under test in the prompt", async () => {
    setResponse({
      proposition: "Certified progress was overstated",
      ifTrue: "Observed progress would sit below the certificate on every measure.",
      ifFalse: "An independent observation would match the certified figure.",
      discriminatingEvidence: ["An independent progress survey on the certificate date"],
      whichIsSupported: "undetermined",
      assumptions: ["The observation method measures the same scope"],
      citations: [CITE("signal", ids.signal), CITE("reconciliation", ids.reconciliation)],
      confidence: 0.55,
    });
    const res = await run("counterfactual_analyst", { signalId: ids.signal });
    expect(res.statusCode).toBe(201);
    const prompt = promptText();
    expect(prompt).toContain("PROPOSITION UNDER TEST");
    expect(prompt).toContain(`type=signal id=${ids.signal}`);

    const row = await queued((res.json() as { reviewIds: string[] }).reviewIds[0]!);
    expect(row.targetType).toBe("counterfactual");
    expect(row.targetId).toBe(ids.signal);
  });

  // The ONLY fleet agent producing an operational target type. Its approval
  // path mutates signals.explanation, so it is exercised end to end here.
  it("anomaly_explainer explains an open signal, and approving it appends to that signal — reversibly", async () => {
    setResponse({
      explanations: [
        {
          signalId: ids.signal,
          benignExplanation: "The certificate may include materials on site not yet installed.",
          concerningExplanation: "Progress may have been certified without an observation.",
          severityAssessment: "high",
          recommendedEvidence: ["The materials-on-site schedule for the same date"],
          citations: [CITE("signal", ids.signal)],
        },
      ],
      citations: [CITE("signal", ids.signal)],
      confidence: 0.68,
    });
    const res = await run("anomaly_explainer");
    expect(res.statusCode).toBe(201);
    expect(promptText()).toContain(`type=signal id=${ids.signal}`);

    const reviewId = (res.json() as { reviewIds: string[] }).reviewIds[0]!;
    const row = await queued(reviewId);
    expect(row.targetType).toBe("signal_explanation");
    expect(row.targetId).toBe(ids.signal);

    const before = (
      await built.app.db.select().from(signals).where(eq(signals.id, ids.signal)).limit(1)
    )[0]!;

    const approve = await built.app.inject({
      method: "POST",
      url: `/api/v1/ai/review/${reviewId}/approve`,
      headers: owner.headers,
    });
    expect(approve.statusCode).toBe(200);

    const after = (
      await built.app.db.select().from(signals).where(eq(signals.id, ids.signal)).limit(1)
    )[0]!;
    expect(after.explanation).toContain("Benign reading:");
    expect(after.explanation).toContain("materials on site");
    // The agent never dispositions a signal — that stays with a human reviewer.
    expect(after.disposition).toBe(before.disposition);

    const [action] = await built.app.db
      .select()
      .from(agentActions)
      .where(eq(agentActions.reviewId, reviewId))
      .limit(1);
    expect(action!.actionType).toBe("explain_signal");
    expect(action!.reversible).toBe(1);

    const rollback = await built.app.inject({
      method: "POST",
      url: `/api/v1/agents/actions/${action!.id}/rollback`,
      headers: owner.headers,
      payload: { reason: "Explanation was wrong" },
    });
    expect(rollback.statusCode).toBe(200);
    const restored = (
      await built.app.db.select().from(signals).where(eq(signals.id, ids.signal)).limit(1)
    )[0]!;
    expect(restored.explanation).toBe(before.explanation);
  });

  it("multi_document_reasoner refuses without a question and cites drawings, specs and RFIs with one", async () => {
    const noQuestion = await run("multi_document_reasoner", {});
    expect(noQuestion.statusCode).toBe(200);
    expect((noQuestion.json() as { skipped: boolean; summary: string }).skipped).toBe(true);
    expect((noQuestion.json() as { summary: string }).summary).toContain("question");

    setResponse({
      answer: "Pile caps at grid C4 are 900mm deep.",
      conflicts: [
        {
          description: "The RFI answer names S-201 rev C; the spec states the depth.",
          citations: [CITE("rfi", ids.rfi), CITE("spec_section", ids.specSection)],
        },
      ],
      citations: [
        CITE("drawing_sheet", ids.sheet),
        CITE("spec_section", ids.specSection),
        CITE("rfi", ids.rfi),
      ],
      confidence: 0.74,
    });
    const res = await run("multi_document_reasoner", { question: "piling" });
    expect(res.statusCode).toBe(201);
    const prompt = promptText();
    expect(prompt).toContain("QUESTION: piling");
    expect(prompt).toContain(`type=drawing_sheet id=${ids.sheet}`);
    expect(prompt).toContain(`type=spec_section id=${ids.specSection}`);

    const row = await queued((res.json() as { reviewIds: string[] }).reviewIds[0]!);
    expect(row.targetType).toBe("document_synthesis");
    expect((row.proposal as Record<string, unknown>)["question"]).toBe("piling");
  });
});

describe("delivery fleet agents", () => {
  it("meeting_minutes_drafter reads the meeting, its agenda items and its actions", async () => {
    setResponse({
      minutes: "3.1 Piling progress — contractor reported 14 days lost; records requested.",
      decisions: ["Records to be issued before the next meeting"],
      actions: [
        {
          title: "Issue the piling records to the PM",
          owner: "Site manager",
          dueDate: "2026-07-22",
          citations: [CITE("meeting_action_item", ids.actionItem)],
        },
      ],
      carriedForward: ["3.1 Piling progress"],
      citations: [CITE("meeting", ids.meeting), CITE("meeting_agenda_item", ids.agendaItem)],
      confidence: 0.8,
    });
    const res = await run("meeting_minutes_drafter", { meetingId: ids.meeting });
    expect(res.statusCode).toBe(201);
    const prompt = promptText();
    expect(prompt).toContain(`type=meeting id=${ids.meeting}`);
    expect(prompt).toContain(`type=meeting_agenda_item id=${ids.agendaItem}`);
    expect(prompt).toContain(`type=meeting_action_item id=${ids.actionItem}`);

    const row = await queued((res.json() as { reviewIds: string[] }).reviewIds[0]!);
    expect(row.targetType).toBe("meeting_minutes");
    expect(row.targetId).toBe(ids.meeting);
  });

  it("incident_classifier reads the recorded incident facts", async () => {
    setResponse({
      reportable: true,
      regimes: ["RIDDOR"],
      riddorCategory: "over_seven_day_injury",
      oshaCaseType: null,
      reportingDeadlineNote: "Report within 15 days of the incident.",
      rootCauseHints: [
        { hypothesis: "No taglines in use", evidenceNeeded: "The lift plan and the toolbox talk record" },
      ],
      rationale: "Nine days of lost time exceeds the seven-day threshold.",
      citations: [CITE("safety_incident", ids.incident)],
      confidence: 0.77,
    });
    const res = await run("incident_classifier", { incidentId: ids.incident });
    expect(res.statusCode).toBe(201);
    expect(promptText()).toContain(`type=safety_incident id=${ids.incident}`);

    const row = await queued((res.json() as { reviewIds: string[] }).reviewIds[0]!);
    expect(row.targetType).toBe("incident_classification");
    expect(row.targetId).toBe(ids.incident);
    expect(row.summary).toContain("REPORTABLE");
  });

  it("spec_compliance_checker puts the governing clause text in the prompt", async () => {
    setResponse({
      compliant: "no",
      deviations: [
        {
          clause: "2.1",
          requirement: "Pile caps 900mm deep minimum",
          submitted: "Shop drawings show 750mm",
          severity: "high",
          citations: [CITE("spec_section", ids.specSection), CITE("submittal", ids.submittal)],
        },
      ],
      missingItems: ["Concrete mix design certificate"],
      rationale: "The submitted depth is below the specified minimum.",
      citations: [CITE("submittal", ids.submittal), CITE("spec_section", ids.specSection)],
      confidence: 0.81,
    });
    const res = await run("spec_compliance_checker", { submittalId: ids.submittal });
    expect(res.statusCode).toBe(201);
    const prompt = promptText();
    expect(prompt).toContain(`type=submittal id=${ids.submittal}`);
    expect(prompt).toContain(`type=spec_section id=${ids.specSection}`);
    expect(prompt).toContain("900mm deep minimum");

    const row = await queued((res.json() as { reviewIds: string[] }).reviewIds[0]!);
    expect(row.targetType).toBe("spec_compliance");
    expect(row.targetId).toBe(ids.submittal);
  });

  it("change_impact_analyst reads the change event with its budget lines and commitments", async () => {
    setResponse({
      costBasis: "Estimated cost of 118,000 recorded on the change event.",
      scheduleImpactDays: 14,
      scheduleBasis: "The change event records 14 days.",
      entitlementNotes: "Clause 60.1(1) compensation event.",
      risks: ["The commitment has no pending change recorded for this scope"],
      unavailable: ["A priced resource breakdown"],
      citations: [
        CITE("change_event", ids.changeEvent),
        CITE("budget_line_item", ids.budgetLine),
        CITE("commitment", ids.commitment),
      ],
      confidence: 0.6,
    });
    const res = await run("change_impact_analyst", { changeEventId: ids.changeEvent });
    expect(res.statusCode).toBe(201);
    const prompt = promptText();
    expect(prompt).toContain(`type=change_event id=${ids.changeEvent}`);
    expect(prompt).toContain(`type=budget_line_item id=${ids.budgetLine}`);
    expect(prompt).toContain(`type=commitment id=${ids.commitment}`);

    const row = await queued((res.json() as { reviewIds: string[] }).reviewIds[0]!);
    expect(row.targetType).toBe("change_impact");
    expect(row.targetId).toBe(ids.changeEvent);
    expect(row.summary).toContain("14 day(s)");
  });

  it("bid_levelling_analyst needs two submissions and levels them when it has them", async () => {
    setResponse({
      scopeGaps: [
        {
          description: "Vendor A excludes disposal of arisings; vendor B does not.",
          affectedVendors: ["ven_a"],
          citations: [CITE("bid_submission", ids.bidA)],
        },
      ],
      outliers: [
        {
          submissionId: ids.bidB,
          observation: "245/m against 180/m for the same item",
          severity: "medium",
          citations: [CITE("bid_submission", ids.bidB)],
        },
      ],
      comparabilityNotes: "Programme durations differ by four weeks.",
      citations: [CITE("bid_package", ids.bidPackage), CITE("bid_submission", ids.bidA)],
      confidence: 0.7,
    });
    const res = await run("bid_levelling_analyst", { packageId: ids.bidPackage });
    expect(res.statusCode).toBe(201);
    const prompt = promptText();
    expect(prompt).toContain(`type=bid_package id=${ids.bidPackage}`);
    expect(prompt).toContain(`type=bid_submission id=${ids.bidA}`);
    expect(prompt).toContain("245.00/m");

    const row = await queued((res.json() as { reviewIds: string[] }).reviewIds[0]!);
    expect(row.targetType).toBe("bid_levelling");
    expect(row.targetId).toBe(ids.bidPackage);
  });

  it("skips levelling a package with a single submission rather than inventing a comparison", async () => {
    const lonePackage = newId("bpk");
    await built.app.db.insert(bidPackages).values({
      id: lonePackage,
      companyId: owner.companyId,
      projectId,
      number: 3,
      reference: "BP-003",
      title: "Groundworks package",
      status: "issued",
      currency: "GBP",
      createdBy: owner.userId,
    });
    await built.app.db.insert(bidSubmissions).values({
      id: newId("bsm"),
      companyId: owner.companyId,
      projectId,
      packageId: lonePackage,
      vendorId: "ven_c",
      reference: "BP-003-C",
      status: "submitted",
      totalAmount: 400_000,
      currency: "GBP",
    });
    const before = callCount;
    const res = await run("bid_levelling_analyst", { packageId: lonePackage });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { skipped: boolean; summary: string };
    expect(body.skipped).toBe(true);
    expect(body.summary).toContain("at least two");
    expect(callCount).toBe(before); // the model was never called
  });
});

/* ================================================================== */
/* Authorisation on the RUNNER (verifier major #1 and #2)              */
/* ================================================================== */

describe("an agent run is gated by the tools that own what it reads", () => {
  it("refuses the cost forecaster to an ai:standard member with budget:none", async () => {
    const before = callCount;
    const res = await run("cost_forecaster", {}, narrowHeaders);
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toContain("budget");
    expect(callCount).toBe(before);

    // …and nothing was written to ai_runs, so nothing leaked into the audit
    // surface either.
    const runs = await built.app.db
      .select()
      .from(aiRuns)
      .where(
        and(eq(aiRuns.companyId, owner.companyId), eq(aiRuns.agentKind, "cost_forecaster")),
      );
    expect(runs).toHaveLength(0);
  });

  // The other half of the same leak: the gathered rows land verbatim in
  // ai_runs.prompt, so the run DETAIL route is gated by the same list. Before
  // this, a field engineer with ai:read and budget:none opened the cost
  // forecaster's run and read every budget line's figures out of the prompt.
  it("refuses the run detail of a budget agent to the same member", async () => {
    setResponse({
      narrative: "Committed cost is 1,100,000 against a revised budget of 1,318,000.",
      drivers: [
        {
          driver: "Revised piling layout",
          direction: "increase",
          basis: "Change event CE-009 carries an estimated 118,000.",
          citations: [CITE("change_event", ids.changeEvent)],
        },
      ],
      watchItems: ["No pending change is recorded against the piling commitment"],
      unavailable: ["A resource-loaded forecast"],
      citations: [CITE("budget_line_item", ids.budgetLine), CITE("commitment", ids.commitment)],
      confidence: 0.6,
    });
    const ran = await run("cost_forecaster");
    expect(ran.statusCode).toBe(201);
    const runId = (ran.json() as { runId: string }).runId;

    const mine = await built.app.inject({
      method: "GET",
      url: `/api/v1/ai/runs/${runId}`,
      headers: owner.headers,
    });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().run.prompt).toContain(ids.budgetLine);

    const denied = await built.app.inject({
      method: "GET",
      url: `/api/v1/ai/runs/${runId}`,
      headers: narrowHeaders,
    });
    expect(denied.statusCode).toBe(403);
  });

  it("refuses the bid leveller to bidding:none and the incident classifier to safety:none", async () => {
    const bidRes = await run("bid_levelling_analyst", { packageId: ids.bidPackage }, narrowHeaders);
    expect(bidRes.statusCode).toBe(403);
    const safetyRes = await run("incident_classifier", { incidentId: ids.incident }, narrowHeaders);
    expect(safetyRes.statusCode).toBe(403);
  });

  it("allows an agent whose tools the same member DOES hold", async () => {
    setResponse({
      explanations: [
        {
          signalId: ids.signal,
          benignExplanation: "Benign.",
          concerningExplanation: "Concerning.",
          severityAssessment: "medium",
          recommendedEvidence: [],
          citations: [CITE("signal", ids.signal)],
        },
      ],
      citations: [CITE("signal", ids.signal)],
      confidence: 0.5,
    });
    // read_only grants assurance:read, which is what anomaly_explainer needs.
    const res = await run("anomaly_explainer", {}, narrowHeaders);
    expect(res.statusCode).toBe(201);
  });

  it("blocks a schedule for an agent the creator is not allowed to run", async () => {
    const res = await built.app.inject({
      method: "POST",
      url: "/api/v1/agents/schedules",
      headers: narrowHeaders,
      payload: { agentKind: "cost_forecaster", projectId, everyMinutes: 1440 },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("agent_policies.allowedRoles is enforced, not just stored", () => {
  it("refuses a member when the tenant restricted the kind to owner/admin", async () => {
    const put = await built.app.inject({
      method: "PUT",
      url: "/api/v1/agents/anomaly_explainer/policy",
      headers: owner.headers,
      payload: { allowedRoles: ["owner", "admin"] },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().policy.allowedRoles).toEqual(["owner", "admin"]);

    const before = callCount;
    const denied = await run("anomaly_explainer", {}, narrowHeaders);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().message).toContain("owner, admin");
    expect(callCount).toBe(before);

    // the owner is in the list, so the same run still works for them
    setResponse({
      explanations: [
        {
          signalId: ids.signal,
          benignExplanation: "Benign.",
          concerningExplanation: "Concerning.",
          severityAssessment: "low",
          recommendedEvidence: [],
          citations: [CITE("signal", ids.signal)],
        },
      ],
      citations: [CITE("signal", ids.signal)],
      confidence: 0.5,
    });
    const allowed = await run("anomaly_explainer");
    expect(allowed.statusCode).toBe(201);

    // restore for any later test
    await built.app.inject({
      method: "PUT",
      url: "/api/v1/agents/anomaly_explainer/policy",
      headers: owner.headers,
      payload: { allowedRoles: [] },
    });
  });

  it("refuses a role that is not a real company role rather than storing it", async () => {
    const res = await built.app.inject({
      method: "PUT",
      url: "/api/v1/agents/anomaly_explainer/policy",
      headers: owner.headers,
      payload: { allowedRoles: ["site_manager"] },
    });
    expect(res.statusCode).toBe(400);
  });
});

/* ================================================================== */
/* Supersession of whole-project proposals (verifier minor #4)         */
/* ================================================================== */

describe("proposals with no target id still supersede their predecessor", () => {
  it("a second whole-project evidence assessment supersedes the first", async () => {
    const body = {
      assessments: [
        {
          assertionId: ids.assertion,
          sufficiency: "partial",
          independenceConcern: false,
          missingEvidence: [],
          rationale: "Partially evidenced.",
          citations: [CITE("assertion", ids.assertion)],
        },
      ],
      citations: [CITE("assertion", ids.assertion)],
      confidence: 0.6,
    };
    setResponse(body);
    const first = await run("evidence_sufficiency_scorer");
    expect(first.statusCode).toBe(201);
    const firstId = (first.json() as { reviewIds: string[] }).reviewIds[0]!;

    setResponse(body);
    const second = await run("evidence_sufficiency_scorer");
    expect(second.statusCode).toBe(201);
    const secondId = (second.json() as { reviewIds: string[] }).reviewIds[0]!;

    expect((await queued(firstId)).status).toBe("superseded");
    expect((await queued(secondId)).status).toBe("pending");

    // exactly one pending whole-project assessment remains for this project
    const pending = await built.app.db
      .select()
      .from(aiReviewQueue)
      .where(
        and(
          eq(aiReviewQueue.companyId, owner.companyId),
          eq(aiReviewQueue.projectId, projectId),
          eq(aiReviewQueue.targetType, "evidence_assessment"),
          eq(aiReviewQueue.status, "pending"),
        ),
      );
    expect(pending).toHaveLength(1);
  });
});

/* ================================================================== */
/* Approving a submittal review now writes something (minor #5)        */
/* ================================================================== */

describe("submittal_review approval", () => {
  it("writes an advisory review comment on the submittal, and a rollback removes it", async () => {
    const runId = newId("airun");
    await built.app.db.insert(aiRuns).values({
      id: runId,
      companyId: owner.companyId,
      projectId,
      agentKind: "submittal_review",
      model: "claude-opus-5",
      requestedBy: owner.userId,
      prompt: "(seeded)",
      output: "(seeded)",
      status: "succeeded",
      inputRefs: [{ type: "submittal", id: ids.submittal }],
      citations: [],
    });
    const reviewId = newId("airev");
    await built.app.db.insert(aiReviewQueue).values({
      id: reviewId,
      companyId: owner.companyId,
      projectId,
      runId,
      targetType: "submittal_review",
      targetId: ids.submittal,
      proposal: {
        agentKind: "submittal_review",
        recommendation: "revise_and_resubmit",
        rationale: "The submitted pile cap depth is below the specified minimum.",
        findings: [{ issue: "Pile cap depth 750mm", clause: "2.1", severity: "high" }],
      },
      summary: "Revise and resubmit",
      confidence: 0.8,
      status: "pending",
    });

    const approve = await built.app.inject({
      method: "POST",
      url: `/api/v1/ai/review/${reviewId}/approve`,
      headers: owner.headers,
    });
    expect(approve.statusCode).toBe(200);

    const written = await built.app.db
      .select()
      .from(comments)
      .where(
        and(
          eq(comments.companyId, owner.companyId),
          eq(comments.recordType, "submittal"),
          eq(comments.recordId, ids.submittal),
        ),
      );
    expect(written).toHaveLength(1);
    expect(written[0]!.body).toContain("revise_and_resubmit");
    expect(written[0]!.body).toContain("Pile cap depth 750mm");
    expect(written[0]!.body).toContain("sets no response code");

    // the submittal's own determination is untouched
    const [submittal] = await built.app.db
      .select()
      .from(submittals)
      .where(eq(submittals.id, ids.submittal))
      .limit(1);
    expect(submittal!.responseCode).toBeNull();

    const ledger = await built.app.db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.companyId, owner.companyId),
          eq(ledgerEntries.objectType, "comment"),
        ),
      );
    expect(ledger.length).toBeGreaterThan(0);

    const [action] = await built.app.db
      .select()
      .from(agentActions)
      .where(eq(agentActions.reviewId, reviewId))
      .limit(1);
    expect(action!.actionType).toBe("comment_submittal_review");
    expect(action!.reversible).toBe(1);

    const rollback = await built.app.inject({
      method: "POST",
      url: `/api/v1/agents/actions/${action!.id}/rollback`,
      headers: owner.headers,
      payload: { reason: "Superseded by a human review" },
    });
    expect(rollback.statusCode).toBe(200);
    const afterRollback = await built.app.db
      .select()
      .from(comments)
      .where(eq(comments.recordId, ids.submittal));
    expect(afterRollback).toHaveLength(0);
  });
});

/* ================================================================== */
/* photo-intel: owning tool + reversible action (minor #7)             */
/* ================================================================== */

describe("photo intelligence", () => {
  it("refuses a caller with ai:standard but no photos access", async () => {
    await built.app.db
      .update(projectMemberships)
      .set({
        overrides: {
          ai: "standard",
          assurance: "read",
          budget: "none",
          bidding: "none",
          safety: "none",
          photos: "none",
        },
      })
      .where(
        and(
          eq(projectMemberships.projectId, projectId),
          eq(projectMemberships.userId, narrow.userId),
        ),
      );
    const before = callCount;
    const res = await built.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/ai/photo-intel`,
      headers: narrowHeaders,
      payload: { photoId: ids.photo },
    });
    expect(res.statusCode).toBe(403);
    expect(callCount).toBe(before);
  });

  it("records the tag write as a reversible agent action", async () => {
    setResponse({
      tags: ["rebar", "pile cap"],
      progressSummary: "Reinforcement cage placed in the pile cap.",
      safetySignals: [],
      confidence: 0.7,
    });
    const res = await built.app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/ai/photo-intel`,
      headers: owner.headers,
      payload: { photoId: ids.photo },
    });
    expect(res.statusCode).toBe(200);
    const actionId = (res.json() as { actionId: string }).actionId;
    expect(actionId).toBeTruthy();

    const [tagged] = await built.app.db
      .select()
      .from(photos)
      .where(eq(photos.id, ids.photo))
      .limit(1);
    expect(tagged!.aiTags).toEqual(["rebar", "pile cap"]);

    const rollback = await built.app.inject({
      method: "POST",
      url: `/api/v1/agents/actions/${actionId}/rollback`,
      headers: owner.headers,
      payload: { reason: "Tags were wrong" },
    });
    expect(rollback.statusCode).toBe(200);
    const [restored] = await built.app.db
      .select()
      .from(photos)
      .where(eq(photos.id, ids.photo))
      .limit(1);
    expect(restored!.aiTags).toEqual(["existing-tag"]);
    expect(restored!.aiSummary).toBe("Set by the field team.");
  });
});

/* ================================================================== */
/* Governance reports are an owner/admin surface (minor #6)            */
/* ================================================================== */

describe("governance report visibility", () => {
  it("a plain member cannot read the bias or validation reports", async () => {
    const created = await built.app.inject({
      method: "POST",
      url: "/api/v1/agents/reports/bias?days=30",
      headers: owner.headers,
      payload: {},
    });
    expect(created.statusCode).toBe(201);
    const reportId = created.json().id as string;

    const list = await built.app.inject({
      method: "GET",
      url: "/api/v1/agents/reports",
      headers: narrowHeaders,
    });
    expect(list.statusCode).toBe(403);

    const detail = await built.app.inject({
      method: "GET",
      url: `/api/v1/agents/reports/${reportId}`,
      headers: narrowHeaders,
    });
    expect(detail.statusCode).toBe(403);

    const ok = await built.app.inject({
      method: "GET",
      url: `/api/v1/agents/reports/${reportId}`,
      headers: owner.headers,
    });
    expect(ok.statusCode).toBe(200);
  });
});
