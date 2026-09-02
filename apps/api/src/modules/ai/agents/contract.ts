/**
 * Contract-side agents (Vol II X #1005–#1009, #1015–#1016).
 *
 *   obligation_monitor        scans obligations and contract events for the
 *                             ones nobody performed and the ones about to
 *                             fall due (#1008–#1009)
 *   time_bar_notice_drafter   drafts the notice a live time bar demands,
 *                             from the clause and the contemporaneous record
 *                             (#1006–#1007)
 *   claim_narrative_drafter   assembles the entitlement narrative for a claim
 *                             from delay events and contract events (#1015)
 *   rebuttal_finder           finds the records that CONTRADICT a claim, on
 *                             purpose: the platform's job is to test an
 *                             assertion, not to help win with it (#1016)
 *
 * Every one of them proposes; none of them writes to a contract, an
 * obligation or a claim. Approval happens in the review queue.
 */
import { and, asc, desc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import { z } from "zod";
import {
  contractEvents,
  contracts,
  dailyLogs,
  delayEvents,
  forensicClaims,
  obligations,
  rfis,
} from "@constructos/db";
import { citationList, findingsOutput, outputContract, requiredConfidence } from "./schemas.js";
import {
  clip,
  daysBetween,
  defineAgent,
  isoDay,
  refsOf,
  renderEvidence,
  type AgentContext,
  type EvidenceRow,
  type GatherResult,
  type ProposalDraft,
} from "./types.js";

const LOOKAHEAD_DAYS = 30;

function paramString(ctx: AgentContext, key: string): string | null {
  const v = ctx.params[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function paramNumber(ctx: AgentContext, key: string, fallback: number): number {
  const v = ctx.params[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/* ================================================================== */
/* obligation_monitor (#1008–#1009)                                    */
/* ================================================================== */

export const obligationMonitor = defineAgent({
  kind: "obligation_monitor",
  name: "Obligation monitor",
  description:
    "Scans the project's obligations and contract events for obligations nobody performed and deadlines about to fall due, and explains each with the clause it comes from.",
  category: "monitor",
  scope: "project",
  inputs: ["obligations", "contract events", "contracts"],
  outputs: ["obligation findings", "integrity signals"],
  dataCategories: ["contract_terms", "assurance_records"],
  targetTypes: ["obligation_finding"],
  consequential: true,
  schedulable: true,
  requireCitations: true,
  defaults: { maxRunsPerDay: 60 },
  schema: findingsOutput,
  system: [
    "You are the ConstructOS obligation monitor for a construction contract.",
    "Your job is to identify obligations that were NOT performed by their deadline, and obligations that fall due soon and have no evidence of performance.",
    "An obligation with satisfying evidence recorded is NOT a finding. Say nothing about it.",
    "Severity: 'critical' when a deadline has passed and the obligation carries a time bar; 'high' when a deadline has passed; 'medium' when it falls due within a week; 'low' otherwise.",
    outputContract(
      '{"findings":[{"recordType":"obligation","recordId":string,"title":string,"severity":string,"rationale":string,"recommendedAction":string,"citations":[{"type":string,"id":string}]}],"summary":string,"citations":[{"type":string,"id":string}],"confidence":number}',
    ),
  ].join("\n"),

  async gather(ctx: AgentContext): Promise<GatherResult> {
    if (!ctx.projectId) return { context: "", inputRefs: [], skip: "Needs a project" };
    const horizonDays = paramNumber(ctx, "horizonDays", LOOKAHEAD_DAYS);
    const horizon = new Date(ctx.now.getTime() + horizonDays * 86_400_000)
      .toISOString()
      .slice(0, 10);

    const openObligations = await ctx.db
      .select()
      .from(obligations)
      .where(
        and(
          eq(obligations.companyId, ctx.companyId),
          eq(obligations.projectId, ctx.projectId),
          inArray(obligations.status, ["open", "breached", "disputed"]),
          or(isNull(obligations.deadline), lte(obligations.deadline, horizon)),
        ),
      )
      .orderBy(asc(obligations.deadline))
      .limit(40);

    const events = await ctx.db
      .select()
      .from(contractEvents)
      .where(
        and(
          eq(contractEvents.companyId, ctx.companyId),
          eq(contractEvents.projectId, ctx.projectId),
          isNull(contractEvents.noticeServedAt),
        ),
      )
      .orderBy(asc(contractEvents.noticeDeadline))
      .limit(25);

    if (openObligations.length === 0 && events.length === 0) {
      return {
        context: "",
        inputRefs: [],
        skip: "No open obligations and no un-noticed contract events inside the horizon",
      };
    }

    const rows: EvidenceRow[] = [];
    for (const o of openObligations) {
      const dueIn = daysBetween(ctx.now, o.deadline);
      rows.push({
        type: "obligation",
        id: o.id,
        label: `Obligation from clause ${o.sourceClause ?? "(unstated)"} — status ${o.status}`,
        detail: [
          `Trigger: ${clip(o.trigger, 400)}`,
          `Deadline: ${isoDay(o.deadline)}${dueIn === null ? "" : ` (${dueIn} days from now)`}`,
          `Evidence required: ${clip(o.evidenceRequirement, 300)}`,
          `Satisfying evidence recorded: ${o.satisfiedEvidenceId ? "yes" : "NO"}`,
          `Warn days before: ${o.warnDaysBefore ?? "(unset)"}`,
        ].join("\n"),
      });
    }
    for (const e of events) {
      const dueIn = daysBetween(ctx.now, e.noticeDeadline);
      rows.push({
        type: "contract_event",
        id: e.id,
        label: `Contract event #${e.number} ${e.kind} — ${clip(e.title, 120)}`,
        detail: [
          `Clause: ${e.clauseRef ?? "(unstated)"}; status ${e.status}`,
          `Event date: ${isoDay(e.eventDate)}; notice deadline ${isoDay(e.noticeDeadline)}${
            dueIn === null ? "" : ` (${dueIn} days from now)`
          }`,
          "Notice served: NO",
          `Description: ${clip(e.description, 600)}`,
        ].join("\n"),
      });
    }

    return {
      context: renderEvidence(rows),
      inputRefs: refsOf(rows),
      contradictions: openObligations.filter((o) => o.satisfiedEvidenceId).length,
      facts: { horizonDays },
    };
  },

  propose(output, ctx): ProposalDraft[] {
    return output.findings.map((f) => ({
      targetType: "obligation_finding" as const,
      targetId: f.recordId ?? null,
      summary: `${f.severity.toUpperCase()}: ${f.title}`,
      proposal: {
        ...f,
        agentKind: "obligation_monitor",
        projectId: ctx.projectId,
      },
      confidence: output.confidence,
      signal:
        f.severity === "high" || f.severity === "critical"
          ? {
              detector: "agent_obligation_monitor",
              severity: f.severity,
              title: f.title.slice(0, 200),
              explanation: f.rationale,
              evidenceRefs: f.citations,
            }
          : undefined,
    }));
  },

  summarise(output, proposals) {
    if (proposals.length === 0) return "No unperformed or imminent obligations found in the horizon";
    return `${proposals.length} obligation finding(s); ${output.summary ?? "see findings"}`;
  },
});

/* ================================================================== */
/* time_bar_notice_drafter (#1006–#1007)                               */
/* ================================================================== */

const noticeDraftSchema = z.object({
  subject: z.string().min(1).max(300),
  noticeText: z.string().min(1).max(20_000),
  clauseRef: z.string().max(120).optional(),
  deadline: z.string().max(40).optional(),
  urgency: z.enum(["expired", "critical", "soon", "routine"]).catch("routine"),
  missingFacts: z.array(z.string().max(400)).max(20).default([]).catch([]),
  citations: citationList,
  confidence: requiredConfidence,
});

export const timeBarNoticeDrafter = defineAgent({
  kind: "time_bar_notice_drafter",
  name: "Time-bar notice drafter",
  description:
    "Drafts the notice a live time bar requires, from the contract clause and the contemporaneous records, and lists the facts the draft is still missing.",
  category: "drafter",
  scope: "project",
  inputs: ["contract event", "contract", "obligations", "daily logs"],
  outputs: ["notice draft"],
  dataCategories: ["contract_terms", "correspondence", "field_records"],
  targetTypes: ["notice_draft"],
  consequential: false,
  schedulable: false,
  requireCitations: true,
  defaults: { maxRunsPerDay: 60 },
  schema: noticeDraftSchema,
  system: [
    "You are the ConstructOS notice drafter. Draft a contractual notice for the supplied event.",
    "Use the clause reference and the contract form supplied; do not invent clause numbers, dates or quantities.",
    "State only facts present in the evidence. Where a fact a compliant notice needs is absent, add it to missingFacts instead of inventing it.",
    "urgency: 'expired' when the deadline has passed, 'critical' within 3 days, 'soon' within 10, else 'routine'.",
    outputContract(
      '{"subject":string,"noticeText":string,"clauseRef":string,"deadline":string,"urgency":string,"missingFacts":[string],"citations":[{"type":string,"id":string}],"confidence":number}',
    ),
  ].join("\n"),

  async gather(ctx: AgentContext): Promise<GatherResult> {
    if (!ctx.projectId) return { context: "", inputRefs: [], skip: "Needs a project" };
    const eventId = paramString(ctx, "contractEventId");

    const scope = and(
      eq(contractEvents.companyId, ctx.companyId),
      eq(contractEvents.projectId, ctx.projectId),
    );
    const candidates = eventId
      ? await ctx.db
          .select()
          .from(contractEvents)
          .where(and(scope, eq(contractEvents.id, eventId)))
          .limit(1)
      : await ctx.db
          .select()
          .from(contractEvents)
          .where(and(scope, isNull(contractEvents.noticeServedAt)))
          .orderBy(asc(contractEvents.noticeDeadline))
          .limit(1);

    const event = candidates[0];
    if (!event) {
      return {
        context: "",
        inputRefs: [],
        skip: eventId
          ? "Contract event not found in this project"
          : "No contract event awaiting a notice",
      };
    }

    const [contract] = event.contractId
      ? await ctx.db
          .select()
          .from(contracts)
          .where(and(eq(contracts.id, event.contractId), eq(contracts.companyId, ctx.companyId)))
          .limit(1)
      : [];

    const relatedLogs = await ctx.db
      .select({ id: dailyLogs.id, logDate: dailyLogs.logDate, notes: dailyLogs.notes })
      .from(dailyLogs)
      .where(
        and(eq(dailyLogs.companyId, ctx.companyId), eq(dailyLogs.projectId, ctx.projectId)),
      )
      .orderBy(desc(dailyLogs.logDate))
      .limit(5);

    const rows: EvidenceRow[] = [
      {
        type: "contract_event",
        id: event.id,
        label: `Contract event #${event.number} ${event.kind} — ${clip(event.title, 120)}`,
        detail: [
          `Clause: ${event.clauseRef ?? "(unstated)"}`,
          `Event date: ${isoDay(event.eventDate)}; notice deadline ${isoDay(event.noticeDeadline)} (${
            daysBetween(ctx.now, event.noticeDeadline) ?? "unknown"
          } days from now)`,
          `Estimated cost impact: ${event.costImpactEstimate ?? "not stated"}; time impact days: ${
            event.timeImpactDaysEstimate ?? "not stated"
          }`,
          `Description: ${clip(event.description, 3000)}`,
        ].join("\n"),
      },
    ];
    if (contract) {
      rows.push({
        type: "contract",
        id: contract.id,
        label: `Contract ${contract.name} (${contract.form}${contract.necOption ? ` option ${contract.necOption}` : ""})`,
        detail: [
          `Base date ${isoDay(contract.baseDate)}, completion ${isoDay(contract.completionDate)}`,
          `Parties: ${clip(JSON.stringify(contract.parties ?? {}), 600)}`,
          `Particular conditions: ${clip(JSON.stringify(contract.particularConditions ?? {}), 1500)}`,
        ].join("\n"),
      });
    }
    for (const log of relatedLogs) {
      rows.push({
        type: "daily_log",
        id: log.id,
        label: `Daily log ${log.logDate}`,
        detail: clip(log.notes, 500),
      });
    }

    return { context: renderEvidence(rows), inputRefs: refsOf(rows), facts: { eventId: event.id } };
  },

  propose(output, ctx, gathered): ProposalDraft[] {
    const eventId = typeof gathered.facts?.["eventId"] === "string"
      ? (gathered.facts["eventId"] as string)
      : null;
    return [
      {
        targetType: "notice_draft" as const,
        targetId: eventId,
        summary: `${output.urgency.toUpperCase()} notice draft: ${output.subject}`,
        proposal: { ...output, projectId: ctx.projectId },
        confidence: output.confidence,
      },
    ];
  },

  summarise(output) {
    return `Notice draft "${output.subject}" (${output.urgency}); ${output.missingFacts.length} missing fact(s)`;
  },
});

/* ================================================================== */
/* claim_narrative_drafter (#1015)                                     */
/* ================================================================== */

const claimNarrativeSchema = z.object({
  narrative: z.string().min(1).max(30_000),
  headsOfClaim: z
    .array(
      z.object({
        head: z.string().min(1).max(200),
        basis: z.string().max(2000),
        supported: z.boolean(),
      }),
    )
    .max(20)
    .default([])
    .catch([]),
  gaps: z.array(z.string().max(500)).max(30).default([]).catch([]),
  citations: citationList,
  confidence: requiredConfidence,
});

export const claimNarrativeDrafter = defineAgent({
  kind: "claim_narrative_drafter",
  name: "Claim narrative drafter",
  description:
    "Assembles the entitlement narrative for a claim from its delay events and contract events, and lists the contemporaneous records the narrative still lacks.",
  category: "drafter",
  scope: "project",
  inputs: ["forensic claim", "delay events", "contract events"],
  outputs: ["claim narrative", "evidence gaps"],
  dataCategories: ["contract_terms", "schedule", "field_records"],
  targetTypes: ["claim_narrative"],
  consequential: false,
  schedulable: false,
  requireCitations: true,
  maxTokens: 20_000,
  schema: claimNarrativeSchema,
  system: [
    "You are the ConstructOS claim narrative drafter for a construction claim.",
    "Write a chronological entitlement narrative that a contract administrator could test against the record.",
    "Mark a head of claim supported ONLY when a supplied record evidences it; otherwise supported=false and add the missing record to gaps.",
    "Never state a quantum, a period or a causal chain the evidence does not carry.",
    outputContract(
      '{"narrative":string,"headsOfClaim":[{"head":string,"basis":string,"supported":boolean}],"gaps":[string],"citations":[{"type":string,"id":string}],"confidence":number}',
    ),
  ].join("\n"),

  async gather(ctx: AgentContext): Promise<GatherResult> {
    if (!ctx.projectId) return { context: "", inputRefs: [], skip: "Needs a project" };
    const claimId = paramString(ctx, "claimId");
    const [claim] = claimId
      ? await ctx.db
          .select()
          .from(forensicClaims)
          .where(
            and(
              eq(forensicClaims.id, claimId),
              eq(forensicClaims.companyId, ctx.companyId),
              eq(forensicClaims.projectId, ctx.projectId),
            ),
          )
          .limit(1)
      : await ctx.db
          .select()
          .from(forensicClaims)
          .where(
            and(
              eq(forensicClaims.companyId, ctx.companyId),
              eq(forensicClaims.projectId, ctx.projectId),
            ),
          )
          .orderBy(desc(forensicClaims.number))
          .limit(1);

    if (!claim) return { context: "", inputRefs: [], skip: "No claim to narrate on this project" };

    const eventIds = (claim.delayEventIds ?? []).filter((id): id is string => typeof id === "string");
    const delays = eventIds.length
      ? await ctx.db
          .select()
          .from(delayEvents)
          .where(
            and(eq(delayEvents.companyId, ctx.companyId), inArray(delayEvents.id, eventIds)),
          )
          .limit(30)
      : await ctx.db
          .select()
          .from(delayEvents)
          .where(
            and(
              eq(delayEvents.companyId, ctx.companyId),
              eq(delayEvents.projectId, ctx.projectId),
            ),
          )
          .orderBy(asc(delayEvents.startDate))
          .limit(30);

    const events = await ctx.db
      .select()
      .from(contractEvents)
      .where(
        and(
          eq(contractEvents.companyId, ctx.companyId),
          eq(contractEvents.projectId, ctx.projectId),
        ),
      )
      .orderBy(asc(contractEvents.eventDate))
      .limit(20);

    const rows: EvidenceRow[] = [
      {
        type: "forensic_claim",
        id: claim.id,
        label: `Claim #${claim.number} ${claim.kind} — ${clip(claim.title, 150)}`,
        detail: [
          `Status ${claim.status}; clause ${claim.clauseRef ?? "(unstated)"}`,
          `Days claimed: ${claim.daysClaimed ?? "not stated"}; amount claimed: ${claim.amountClaimed ?? "not stated"}`,
          `Days assessed: ${claim.daysAssessed ?? "not assessed"}; amount assessed: ${claim.amountAssessed ?? "not assessed"}`,
          `Chronology entries recorded: ${Array.isArray(claim.chronology) ? claim.chronology.length : 0}`,
        ].join("\n"),
      },
    ];
    for (const d of delays) {
      rows.push({
        type: "delay_event",
        id: d.id,
        label: `Delay event #${d.number} — ${clip(d.title, 120)}`,
        detail: [
          `Cause: ${d.cause ?? "(unstated)"}; excusable=${d.excusable}; compensable=${d.compensable}`,
          `Start ${isoDay(d.startDate)}, duration ${d.durationDays ?? "unknown"} days, status ${d.status}`,
          `Description: ${clip(d.description, 800)}`,
        ].join("\n"),
      });
    }
    for (const e of events) {
      rows.push({
        type: "contract_event",
        id: e.id,
        label: `Contract event #${e.number} ${e.kind} — ${clip(e.title, 120)}`,
        detail: `Clause ${e.clauseRef ?? "(unstated)"}; event ${isoDay(e.eventDate)}; notice served ${
          e.noticeServedAt ? isoDay(e.noticeServedAt) : "NO"
        }`,
      });
    }

    return {
      context: renderEvidence(rows),
      inputRefs: refsOf(rows),
      facts: { claimId: claim.id, claimNumber: claim.number },
    };
  },

  propose(output, ctx, gathered): ProposalDraft[] {
    const claimId = typeof gathered.facts?.["claimId"] === "string"
      ? (gathered.facts["claimId"] as string)
      : null;
    return [
      {
        targetType: "claim_narrative" as const,
        targetId: claimId,
        summary: `Claim narrative with ${output.headsOfClaim.length} head(s) and ${output.gaps.length} evidence gap(s)`,
        proposal: { ...output, projectId: ctx.projectId },
        confidence: output.confidence,
      },
    ];
  },

  summarise(output) {
    const supported = output.headsOfClaim.filter((h) => h.supported).length;
    return `${supported}/${output.headsOfClaim.length} heads of claim supported by the record; ${output.gaps.length} gap(s)`;
  },
});

/* ================================================================== */
/* rebuttal_finder (#1016)                                             */
/* ================================================================== */

const rebuttalSchema = z.object({
  rebuttals: z
    .array(
      z.object({
        assertion: z.string().min(1).max(1000),
        contradiction: z.string().min(1).max(2000),
        strength: z.enum(["weak", "moderate", "strong"]).catch("moderate"),
        citations: citationList,
      }),
    )
    .max(30)
    .default([])
    .catch([]),
  unchallenged: z.array(z.string().max(500)).max(30).default([]).catch([]),
  citations: citationList,
  confidence: requiredConfidence,
});

export const rebuttalFinder = defineAgent({
  kind: "rebuttal_finder",
  name: "Rebuttal finder",
  description:
    "Reads a claim and looks for the contemporaneous records that CONTRADICT it — the assurance test, not the advocacy — and states which assertions nothing in the record challenges.",
  category: "analyst",
  scope: "project",
  inputs: ["forensic claim", "daily logs", "RFIs", "delay events"],
  outputs: ["rebuttals", "unchallenged assertions"],
  dataCategories: ["contract_terms", "field_records", "schedule"],
  targetTypes: ["rebuttal"],
  consequential: false,
  schedulable: false,
  requireCitations: true,
  schema: rebuttalSchema,
  system: [
    "You are the ConstructOS rebuttal finder, working for the party TESTING a claim, not making it.",
    "For each assertion in the claim, look for supplied records that contradict it: a daily log showing work proceeding on a day claimed as lost, an RFI answered before the date the claim says it was outstanding, a delay event with a different cause.",
    "Do not manufacture contradictions. An assertion nothing contradicts goes in 'unchallenged' — that is a real and useful answer.",
    outputContract(
      '{"rebuttals":[{"assertion":string,"contradiction":string,"strength":"weak"|"moderate"|"strong","citations":[{"type":string,"id":string}]}],"unchallenged":[string],"citations":[{"type":string,"id":string}],"confidence":number}',
    ),
  ].join("\n"),

  async gather(ctx: AgentContext): Promise<GatherResult> {
    if (!ctx.projectId) return { context: "", inputRefs: [], skip: "Needs a project" };
    const claimId = paramString(ctx, "claimId");
    const [claim] = claimId
      ? await ctx.db
          .select()
          .from(forensicClaims)
          .where(
            and(
              eq(forensicClaims.id, claimId),
              eq(forensicClaims.companyId, ctx.companyId),
              eq(forensicClaims.projectId, ctx.projectId),
            ),
          )
          .limit(1)
      : await ctx.db
          .select()
          .from(forensicClaims)
          .where(
            and(
              eq(forensicClaims.companyId, ctx.companyId),
              eq(forensicClaims.projectId, ctx.projectId),
            ),
          )
          .orderBy(desc(forensicClaims.number))
          .limit(1);
    if (!claim) return { context: "", inputRefs: [], skip: "No claim to test on this project" };

    const logs = await ctx.db
      .select({
        id: dailyLogs.id,
        logDate: dailyLogs.logDate,
        notes: dailyLogs.notes,
        sections: dailyLogs.sections,
        status: dailyLogs.status,
      })
      .from(dailyLogs)
      .where(and(eq(dailyLogs.companyId, ctx.companyId), eq(dailyLogs.projectId, ctx.projectId)))
      .orderBy(desc(dailyLogs.logDate))
      .limit(25);

    const rfiRows = await ctx.db
      .select({
        id: rfis.id,
        number: rfis.number,
        subject: rfis.subject,
        status: rfis.status,
        respondedAt: rfis.respondedAt,
        createdAt: rfis.createdAt,
      })
      .from(rfis)
      .where(and(eq(rfis.companyId, ctx.companyId), eq(rfis.projectId, ctx.projectId)))
      .orderBy(desc(rfis.number))
      .limit(25);

    const rows: EvidenceRow[] = [
      {
        type: "forensic_claim",
        id: claim.id,
        label: `Claim #${claim.number} — ${clip(claim.title, 150)}`,
        detail: [
          `Kind ${claim.kind}, status ${claim.status}, clause ${claim.clauseRef ?? "(unstated)"}`,
          `Days claimed ${claim.daysClaimed ?? "not stated"}, amount claimed ${claim.amountClaimed ?? "not stated"}`,
          `Chronology: ${clip(JSON.stringify(claim.chronology ?? []), 4000)}`,
        ].join("\n"),
      },
    ];
    for (const l of logs) {
      rows.push({
        type: "daily_log",
        id: l.id,
        label: `Daily log ${l.logDate} (${l.status})`,
        detail: `${clip(l.notes, 400)}\nSections: ${clip(JSON.stringify(l.sections ?? {}), 700)}`,
      });
    }
    for (const r of rfiRows) {
      rows.push({
        type: "rfi",
        id: r.id,
        label: `RFI #${r.number} — ${clip(r.subject, 120)}`,
        detail: `Status ${r.status}; raised ${isoDay(r.createdAt)}; answered ${
          r.respondedAt ? isoDay(r.respondedAt) : "not answered"
        }`,
      });
    }

    return {
      context: renderEvidence(rows),
      inputRefs: refsOf(rows),
      contradictions: logs.length + rfiRows.length,
      facts: { claimId: claim.id },
    };
  },

  propose(output, ctx, gathered): ProposalDraft[] {
    const claimId = typeof gathered.facts?.["claimId"] === "string"
      ? (gathered.facts["claimId"] as string)
      : null;
    return [
      {
        targetType: "rebuttal" as const,
        targetId: claimId,
        summary: `${output.rebuttals.length} contradiction(s) found; ${output.unchallenged.length} assertion(s) unchallenged`,
        proposal: { ...output, projectId: ctx.projectId },
        confidence: output.confidence,
      },
    ];
  },

  summarise(output) {
    const strong = output.rebuttals.filter((r) => r.strength === "strong").length;
    return `${output.rebuttals.length} rebuttal(s), ${strong} strong`;
  },
});


/* ================================================================== */
/* contract_risk (#766) — the declared kind nothing implemented        */
/* ================================================================== */

/**
 * Clause-by-clause review of a contract's PARTICULAR conditions against the
 * standard form it amends. The clause library itself is code-resident in
 * modules/contracts (ADR 0007); this agent reads what the tenant recorded on
 * the contract row — the form, the option, and the particular conditions —
 * and is explicit when an amendment cannot be assessed because the standard
 * text was not supplied to it.
 */
export const contractRiskReviewer = defineAgent({
  kind: "contract_risk",
  name: "Contract risk reviewer",
  description:
    "Reviews a contract's particular conditions against the standard form it amends and flags shifted time bars, deleted entitlements and onerous flow-downs, each with the clause it comes from.",
  category: "reviewer",
  scope: "project",
  inputs: ["contract", "particular conditions", "contract events"],
  outputs: ["risk findings"],
  dataCategories: ["contract_terms"],
  targetTypes: ["risk_finding"],
  consequential: true,
  schedulable: false,
  requireCitations: true,
  maxTokens: 12_000,
  schema: findingsOutput,
  system: [
    "You are the ConstructOS contract risk reviewer.",
    "Review the amendments recorded in the particular conditions against the named standard form. Flag: time bars shortened or added, entitlements deleted, caps or exclusions of liability introduced, onerous flow-downs, and payment terms lengthened.",
    "Name the clause reference exactly as it appears in the supplied text. If an amendment's effect cannot be judged without the standard clause text you were not given, say so in the rationale rather than assuming its effect.",
    "Severity: 'critical' for a time bar that could extinguish an entitlement; 'high' for a deleted entitlement or an uncapped liability; otherwise judge on exposure.",
    outputContract(
      '{"findings":[{"recordType":"contract","recordId":string,"title":string,"severity":string,"rationale":string,"recommendedAction":string,"citations":[{"type":string,"id":string}]}],"summary":string,"citations":[{"type":string,"id":string}],"confidence":number}',
    ),
  ].join("\n"),

  async gather(ctx: AgentContext): Promise<GatherResult> {
    if (!ctx.projectId) return { context: "", inputRefs: [], skip: "Needs a project" };
    const contractId = paramString(ctx, "contractId");
    const [contract] = contractId
      ? await ctx.db
          .select()
          .from(contracts)
          .where(
            and(
              eq(contracts.id, contractId),
              eq(contracts.companyId, ctx.companyId),
              eq(contracts.projectId, ctx.projectId),
            ),
          )
          .limit(1)
      : await ctx.db
          .select()
          .from(contracts)
          .where(and(eq(contracts.companyId, ctx.companyId), eq(contracts.projectId, ctx.projectId)))
          .orderBy(desc(contracts.createdAt))
          .limit(1);
    if (!contract) return { context: "", inputRefs: [], skip: "No contract to review on this project" };

    const events = await ctx.db
      .select()
      .from(contractEvents)
      .where(
        and(
          eq(contractEvents.companyId, ctx.companyId),
          eq(contractEvents.contractId, contract.id),
        ),
      )
      .orderBy(asc(contractEvents.eventDate))
      .limit(20);

    const rows: EvidenceRow[] = [
      {
        type: "contract",
        id: contract.id,
        label: `Contract ${contract.name} — form ${contract.form}${contract.necOption ? ` option ${contract.necOption}` : ""}`,
        detail: [
          `Status ${contract.status}; currency ${contract.currency}; sum ${contract.contractSum ?? "not stated"}`,
          `Base date ${isoDay(contract.baseDate)}; commencement ${isoDay(contract.commencementDate)}; completion ${isoDay(contract.completionDate)}`,
          `Retention ${contract.retentionPercent ?? "not stated"}% (cap ${contract.retentionCap ?? "none"}); defects period ${contract.defectsPeriodMonths ?? "not stated"} months`,
          `LDs ${contract.ldRatePerDay ?? "not stated"}/day, cap ${contract.ldCap ?? "none"}`,
          `Particular conditions as recorded:\n${clip(JSON.stringify(contract.particularConditions ?? {}, null, 1), 9000)}`,
        ].join("\n"),
      },
    ];
    for (const e of events) {
      rows.push({
        type: "contract_event",
        id: e.id,
        label: `Contract event #${e.number} ${e.kind} — ${clip(e.title, 110)}`,
        detail: `Clause ${e.clauseRef ?? "(unstated)"}; notice deadline ${isoDay(e.noticeDeadline)}; served ${e.noticeServedAt ? "yes" : "NO"}`,
      });
    }
    return {
      context: renderEvidence(rows),
      inputRefs: refsOf(rows),
      facts: { contractId: contract.id },
    };
  },

  propose(output, ctx, gathered): ProposalDraft[] {
    const contractId = typeof gathered.facts?.["contractId"] === "string"
      ? (gathered.facts["contractId"] as string)
      : null;
    return output.findings.map((f) => ({
      targetType: "risk_finding" as const,
      targetId: f.recordId ?? contractId,
      summary: `${f.severity.toUpperCase()}: ${f.title}`,
      proposal: { ...f, contractId, projectId: ctx.projectId },
      confidence: output.confidence,
      signal:
        f.severity === "critical"
          ? {
              detector: "agent_contract_risk",
              severity: f.severity,
              title: f.title.slice(0, 200),
              explanation: f.rationale,
              evidenceRefs: f.citations,
            }
          : undefined,
    }));
  },

  summarise(output, proposals) {
    return proposals.length === 0
      ? "No onerous amendment identified in the recorded particular conditions"
      : `${proposals.length} contract risk finding(s)`;
  },
});

export const contractAgents = [
  contractRiskReviewer,
  obligationMonitor,
  timeBarNoticeDrafter,
  claimNarrativeDrafter,
  rebuttalFinder,
];
