/**
 * Delivery-side agents — the ones that read the money, the programme, the
 * field and the market (Vol I §6.4 #766–#773, Vol II X #1010).
 *
 *   risk_monitor            leading indicators against the risk register
 *   cost_forecaster         an EAC narrative whose every figure is a row
 *   schedule_risk_analyst   what on the critical path is actually at risk
 *   meeting_minutes_drafter minutes from the agenda and the actions taken
 *   incident_classifier     RIDDOR/OSHA reportability and root-cause hints
 *   spec_compliance_checker a submittal against the clause text that governs
 *   change_impact_analyst   what a change event really costs and delays
 *   bid_levelling_analyst   what the bids do not have in common
 *
 * Every one of them proposes. None writes to a budget, a programme, an
 * incident or an award: those are decisions with consequences and they stay
 * with the people accountable for them.
 */
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { z } from "zod";
import {
  bidPackages,
  bidSubmissionLines,
  bidSubmissions,
  budgetLineItems,
  changeEvents,
  commitments,
  delayEvents,
  meetingActionItems,
  meetingAgendaItems,
  meetings,
  nonConformanceReports,
  risks,
  rfis,
  safetyIncidents,
  scheduleTasks,
  schedules,
  specSectionRevisions,
  specSections,
  submittals,
} from "@constructos/db";
import { citationList, findingsOutput, outputContract, requiredConfidence } from "./schemas.js";
import {
  clip,
  defineAgent,
  isoDay,
  refsOf,
  renderEvidence,
  type AgentContext,
  type EvidenceRow,
  type GatherResult,
  type ProposalDraft,
} from "./types.js";

function paramString(ctx: AgentContext, key: string): string | null {
  const v = ctx.params[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

const money = (v: number | null | undefined): string =>
  typeof v === "number" && Number.isFinite(v) ? v.toFixed(2) : "not recorded";

/* ================================================================== */
/* risk_monitor (#1010)                                                */
/* ================================================================== */

export const riskMonitor = defineAgent({
  kind: "risk_monitor",
  name: "Risk monitor",
  description:
    "Reads the leading indicators — open NCRs, unanswered RFIs, delay events, safety incidents — against the risk register and flags the risks whose triggers are already showing.",
  category: "monitor",
  scope: "project",
  inputs: ["risk register", "NCRs", "RFIs", "delay events", "safety incidents"],
  outputs: ["risk findings", "signals"],
  dataCategories: ["schedule", "field_records", "safety_records", "assurance_records"],
  targetTypes: ["risk_finding"],
  consequential: true,
  schedulable: true,
  requireCitations: true,
  schema: findingsOutput,
  system: [
    "You are the ConstructOS risk monitor.",
    "Compare the registered risks against the leading indicators supplied. A finding is a risk whose trigger conditions are visible in the current record, or an emerging risk the register does not contain at all.",
    "Do not restate the register. A risk with no indicator behind it is not a finding.",
    "Severity reflects what the indicators show, not the register's own score.",
    outputContract(
      '{"findings":[{"recordType":string,"recordId":string,"title":string,"severity":string,"rationale":string,"recommendedAction":string,"citations":[{"type":string,"id":string}]}],"summary":string,"citations":[{"type":string,"id":string}],"confidence":number}',
    ),
  ].join("\n"),

  async gather(ctx: AgentContext): Promise<GatherResult> {
    if (!ctx.projectId) return { context: "", inputRefs: [], skip: "Needs a project" };
    const [registered, ncrs, openRfis, delays, incidents] = await Promise.all([
      ctx.db
        .select()
        .from(risks)
        .where(and(eq(risks.companyId, ctx.companyId), eq(risks.projectId, ctx.projectId)))
        .orderBy(desc(risks.number))
        .limit(25),
      ctx.db
        .select()
        .from(nonConformanceReports)
        .where(
          and(
            eq(nonConformanceReports.companyId, ctx.companyId),
            eq(nonConformanceReports.projectId, ctx.projectId),
          ),
        )
        .orderBy(desc(nonConformanceReports.number))
        .limit(15),
      ctx.db
        .select({
          id: rfis.id,
          number: rfis.number,
          subject: rfis.subject,
          status: rfis.status,
          dueDate: rfis.dueDate,
        })
        .from(rfis)
        .where(
          and(
            eq(rfis.companyId, ctx.companyId),
            eq(rfis.projectId, ctx.projectId),
            eq(rfis.status, "open"),
          ),
        )
        .orderBy(desc(rfis.number))
        .limit(15),
      ctx.db
        .select()
        .from(delayEvents)
        .where(
          and(eq(delayEvents.companyId, ctx.companyId), eq(delayEvents.projectId, ctx.projectId)),
        )
        .orderBy(desc(delayEvents.number))
        .limit(10),
      ctx.db
        .select({
          id: safetyIncidents.id,
          number: safetyIncidents.number,
          title: safetyIncidents.title,
          severity: safetyIncidents.severity,
          occurredAt: safetyIncidents.occurredAt,
          isLostTime: safetyIncidents.isLostTime,
        })
        .from(safetyIncidents)
        .where(
          and(
            eq(safetyIncidents.companyId, ctx.companyId),
            eq(safetyIncidents.projectId, ctx.projectId),
          ),
        )
        .orderBy(desc(safetyIncidents.number))
        .limit(10),
    ]);

    if (
      registered.length === 0 &&
      ncrs.length === 0 &&
      openRfis.length === 0 &&
      delays.length === 0 &&
      incidents.length === 0
    ) {
      return { context: "", inputRefs: [], skip: "No risks and no leading indicators recorded yet" };
    }

    const rows: EvidenceRow[] = [];
    for (const r of registered) {
      rows.push({
        type: "risk",
        id: r.id,
        label: `Risk #${r.number} ${r.category ?? ""} — ${clip(r.title, 130)}`,
        detail: [
          `Status ${r.status}; P${r.probabilityScore ?? "?"}×I${r.impactScore ?? "?"}`,
          `Cost impact: ${r.costImpact ? clip(JSON.stringify(r.costImpact), 200) : "not recorded"}; duration impact ${r.durationImpact ?? "not stated"} days`,
          `Description: ${clip(r.description, 600)}`,
        ].join("\n"),
      });
    }
    for (const n of ncrs) {
      rows.push({
        type: "ncr",
        id: n.id,
        label: `NCR #${n.number} (${n.severity}) — ${clip(n.title, 120)}`,
        detail: `Status ${n.status}; disposition ${n.disposition ?? "none"}; cost impact ${money(n.costImpact)}; schedule impact ${n.scheduleImpactDays ?? 0} days`,
      });
    }
    for (const r of openRfis) {
      rows.push({
        type: "rfi",
        id: r.id,
        label: `Open RFI #${r.number} — ${clip(r.subject, 120)}`,
        detail: `Due ${isoDay(r.dueDate)}`,
      });
    }
    for (const d of delays) {
      rows.push({
        type: "delay_event",
        id: d.id,
        label: `Delay event #${d.number} — ${clip(d.title, 120)}`,
        detail: `Cause ${d.cause ?? "unstated"}; ${d.durationDays ?? "?"} days from ${isoDay(d.startDate)}; status ${d.status}`,
      });
    }
    for (const i of incidents) {
      rows.push({
        type: "safety_incident",
        id: i.id,
        label: `Incident #${i.number} (${i.severity}) — ${clip(i.title, 120)}`,
        detail: `Occurred ${isoDay(i.occurredAt)}; lost time: ${i.isLostTime ? "yes" : "no"}`,
      });
    }

    return {
      context: renderEvidence(rows),
      inputRefs: refsOf(rows),
      contradictions: registered.filter((r) => r.status === "closed").length,
    };
  },

  propose(output, ctx): ProposalDraft[] {
    return output.findings.map((f) => ({
      targetType: "risk_finding" as const,
      targetId: f.recordId ?? null,
      summary: `${f.severity.toUpperCase()}: ${f.title}`,
      proposal: { ...f, projectId: ctx.projectId },
      confidence: output.confidence,
      signal:
        f.severity === "high" || f.severity === "critical"
          ? {
              detector: "agent_risk_monitor",
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
      ? "No risk whose trigger conditions are visible in the current record"
      : `${proposals.length} risk finding(s) from leading indicators`;
  },
});

/* ================================================================== */
/* cost_forecaster                                                     */
/* ================================================================== */

const costForecastSchema = z.object({
  narrative: z.string().min(1).max(12_000),
  drivers: z
    .array(
      z.object({
        driver: z.string().min(1).max(300),
        direction: z.enum(["increase", "decrease", "uncertain"]).catch("uncertain"),
        basis: z.string().max(1500),
        citations: citationList,
      }),
    )
    .max(20)
    .default([])
    .catch([]),
  watchItems: z.array(z.string().max(400)).max(20).default([]).catch([]),
  unavailable: z.array(z.string().max(300)).max(20).default([]).catch([]),
  citations: citationList,
  confidence: requiredConfidence,
});

export const costForecaster = defineAgent({
  kind: "cost_forecaster",
  name: "Cost forecaster",
  description:
    "Writes the estimate-at-completion narrative from the budget lines, commitments and change events, and says explicitly which figures the platform does not hold.",
  category: "analyst",
  scope: "project",
  inputs: ["budget line items", "commitments", "change events"],
  outputs: ["cost forecast narrative"],
  dataCategories: ["financial"],
  targetTypes: ["cost_forecast"],
  consequential: false,
  schedulable: true,
  requireCitations: true,
  maxTokens: 12_000,
  schema: costForecastSchema,
  system: [
    "You are the ConstructOS cost forecaster.",
    "Every figure you state must come from a supplied row and be cited. If a figure a forecast normally needs is absent, put it in 'unavailable' — never estimate it and never write 0 for a number the platform does not hold.",
    "Never add amounts in different currencies together. If the rows carry more than one currency, say so and keep them apart.",
    outputContract(
      '{"narrative":string,"drivers":[{"driver":string,"direction":"increase"|"decrease"|"uncertain","basis":string,"citations":[{"type":string,"id":string}]}],"watchItems":[string],"unavailable":[string],"citations":[{"type":string,"id":string}],"confidence":number}',
    ),
  ].join("\n"),

  async gather(ctx: AgentContext): Promise<GatherResult> {
    if (!ctx.projectId) return { context: "", inputRefs: [], skip: "Needs a project" };
    const [lines, commitmentRows, changes] = await Promise.all([
      ctx.db
        .select()
        .from(budgetLineItems)
        .where(
          and(
            eq(budgetLineItems.companyId, ctx.companyId),
            eq(budgetLineItems.projectId, ctx.projectId),
          ),
        )
        .limit(40),
      ctx.db
        .select()
        .from(commitments)
        .where(
          and(eq(commitments.companyId, ctx.companyId), eq(commitments.projectId, ctx.projectId)),
        )
        .orderBy(desc(commitments.number))
        .limit(20),
      ctx.db
        .select()
        .from(changeEvents)
        .where(
          and(eq(changeEvents.companyId, ctx.companyId), eq(changeEvents.projectId, ctx.projectId)),
        )
        .orderBy(desc(changeEvents.number))
        .limit(20),
    ]);
    if (lines.length === 0 && commitmentRows.length === 0 && changes.length === 0) {
      return { context: "", inputRefs: [], skip: "No budget, commitment or change rows to forecast from" };
    }
    const rows: EvidenceRow[] = [];
    for (const l of lines) {
      rows.push({
        type: "budget_line_item",
        id: l.id,
        label: `Budget line ${l.costCode ?? l.id} — ${clip(l.description, 100)}`,
        detail: [
          `Original ${money(l.originalBudget)}; revised ${money(l.revisedBudget)}; committed ${money(l.committedCost)}`,
          `Job-to-date ${money(l.jobToDateCosts)}; forecast-to-complete ${money(l.forecastToComplete)}; forecast final ${money(l.forecastFinal)}`,
          `Projected over/under ${money(l.projectedOverUnder)}; percent complete ${l.percentComplete ?? "not recorded"}; method ${l.forecastMethod ?? "none"}`,
        ].join("\n"),
      });
    }
    for (const c of commitmentRows) {
      rows.push({
        type: "commitment",
        id: c.id,
        label: `Commitment ${c.reference ?? c.number} — ${clip(c.title, 100)} (${c.currency})`,
        detail: `Revised sum ${money(c.revisedCommitmentSum)}; invoiced ${money(c.totalInvoiced)}; paid ${money(c.totalPaid)}; pending changes ${money(c.pendingChangeSum)}; status ${c.status}`,
      });
    }
    for (const c of changes) {
      rows.push({
        type: "change_event",
        id: c.id,
        label: `Change event ${c.reference ?? c.number} — ${clip(c.title, 100)}`,
        detail: `Status ${c.status}; ROM ${money(c.roughOrderOfMagnitude)}; estimated ${money(c.estimatedCost)}; latest ${money(c.latestCost)}; schedule impact ${c.scheduleImpactDays ?? "not stated"} days`,
      });
    }
    const currencies = new Set(commitmentRows.map((c) => c.currency).filter(Boolean));
    return {
      context: `Currencies present in the commitment rows: ${
        currencies.size ? [...currencies].join(", ") : "(none recorded)"
      }\n\n${renderEvidence(rows)}`,
      inputRefs: refsOf(rows),
      facts: { currencies: [...currencies] },
    };
  },

  propose(output, ctx): ProposalDraft[] {
    return [
      {
        targetType: "cost_forecast" as const,
        targetId: null,
        summary: `Cost forecast narrative: ${output.drivers.length} driver(s), ${output.unavailable.length} figure(s) unavailable`,
        proposal: { ...output, projectId: ctx.projectId },
        confidence: output.confidence,
      },
    ];
  },

  summarise(output) {
    return `${output.drivers.length} cost driver(s); ${output.unavailable.length} figure(s) the platform does not hold`;
  },
});

/* ================================================================== */
/* schedule_risk_analyst                                               */
/* ================================================================== */

export const scheduleRiskAnalyst = defineAgent({
  kind: "schedule_risk_analyst",
  name: "Schedule risk analyst",
  description:
    "Reads the critical and near-critical tasks against the recorded delay events and open constraints, and says which dates are actually exposed.",
  category: "analyst",
  scope: "project",
  inputs: ["schedule tasks", "delay events", "open RFIs"],
  outputs: ["schedule risk findings"],
  dataCategories: ["schedule", "field_records"],
  targetTypes: ["schedule_risk"],
  consequential: false,
  schedulable: true,
  requireCitations: true,
  schema: findingsOutput,
  system: [
    "You are the ConstructOS schedule risk analyst.",
    "Identify the tasks whose dates are exposed: negative or minimal float, an unanswered RFI on the work, an open delay event touching the task.",
    "State the exposure in days only when a supplied row gives you the number. Otherwise describe the exposure without inventing a duration.",
    outputContract(
      '{"findings":[{"recordType":"schedule_task","recordId":string,"title":string,"severity":string,"rationale":string,"recommendedAction":string,"citations":[{"type":string,"id":string}]}],"summary":string,"citations":[{"type":string,"id":string}],"confidence":number}',
    ),
  ].join("\n"),

  async gather(ctx: AgentContext): Promise<GatherResult> {
    if (!ctx.projectId) return { context: "", inputRefs: [], skip: "Needs a project" };
    const scheduleRows = await ctx.db
      .select({ id: schedules.id, name: schedules.name })
      .from(schedules)
      .where(
        and(
          eq(schedules.companyId, ctx.companyId),
          eq(schedules.projectId, ctx.projectId),
          eq(schedules.isActive, 1),
        ),
      )
      .limit(3);
    const scheduleIds = scheduleRows.map((s) => s.id);
    const tasks = scheduleIds.length
      ? await ctx.db
          .select()
          .from(scheduleTasks)
          .where(
            and(
              inArray(scheduleTasks.scheduleId, scheduleIds),
              eq(scheduleTasks.projectId, ctx.projectId),
            ),
          )
          .orderBy(scheduleTasks.totalFloat)
          .limit(30)
      : [];
    const delays = await ctx.db
      .select()
      .from(delayEvents)
      .where(
        and(eq(delayEvents.companyId, ctx.companyId), eq(delayEvents.projectId, ctx.projectId)),
      )
      .orderBy(desc(delayEvents.number))
      .limit(15);
    const openRfis = await ctx.db
      .select({ id: rfis.id, number: rfis.number, subject: rfis.subject, dueDate: rfis.dueDate })
      .from(rfis)
      .where(
        and(
          eq(rfis.companyId, ctx.companyId),
          eq(rfis.projectId, ctx.projectId),
          eq(rfis.status, "open"),
        ),
      )
      .limit(15);

    if (tasks.length === 0 && delays.length === 0) {
      return { context: "", inputRefs: [], skip: "No active schedule tasks and no delay events" };
    }

    const rows: EvidenceRow[] = [];
    for (const t of tasks) {
      rows.push({
        type: "schedule_task",
        id: t.id,
        label: `Task ${t.wbsCode ?? ""} ${clip(t.name, 110)}`.trim(),
        detail: [
          `Start ${isoDay(t.startDate)} finish ${isoDay(t.finishDate)}; duration ${t.durationDays ?? "?"} days`,
          `Total float ${t.totalFloat ?? "not computed"}; critical: ${t.isCritical ? "yes" : "no"}`,
          `Percent complete ${t.percentComplete ?? 0}; actual start ${isoDay(t.actualStart)}; actual finish ${isoDay(t.actualFinish)}`,
        ].join("\n"),
      });
    }
    for (const d of delays) {
      rows.push({
        type: "delay_event",
        id: d.id,
        label: `Delay event #${d.number} — ${clip(d.title, 120)}`,
        detail: `Task ${d.taskId ?? "unlinked"}; ${d.durationDays ?? "?"} days from ${isoDay(d.startDate)}; excusable ${d.excusable}; status ${d.status}`,
      });
    }
    for (const r of openRfis) {
      rows.push({
        type: "rfi",
        id: r.id,
        label: `Open RFI #${r.number} — ${clip(r.subject, 110)}`,
        detail: `Due ${isoDay(r.dueDate)}`,
      });
    }
    return { context: renderEvidence(rows), inputRefs: refsOf(rows) };
  },

  propose(output, ctx): ProposalDraft[] {
    if (output.findings.length === 0) return [];
    return [
      {
        targetType: "schedule_risk" as const,
        targetId: null,
        summary: `${output.findings.length} exposed schedule item(s)`,
        proposal: { ...output, projectId: ctx.projectId },
        confidence: output.confidence,
      },
    ];
  },

  summarise(output) {
    return `${output.findings.length} schedule exposure(s) identified`;
  },
});

/* ================================================================== */
/* meeting_minutes_drafter                                             */
/* ================================================================== */

const minutesSchema = z.object({
  minutes: z.string().min(1).max(30_000),
  decisions: z.array(z.string().max(1000)).max(40).default([]).catch([]),
  actions: z
    .array(
      z.object({
        title: z.string().min(1).max(300),
        owner: z.string().max(200).optional(),
        dueDate: z.string().max(20).optional(),
        citations: citationList,
      }),
    )
    .max(40)
    .default([])
    .catch([]),
  carriedForward: z.array(z.string().max(400)).max(30).default([]).catch([]),
  citations: citationList,
  confidence: requiredConfidence,
});

export const meetingMinutesDrafter = defineAgent({
  kind: "meeting_minutes_drafter",
  name: "Meeting minutes drafter",
  description:
    "Drafts minutes from the meeting's agenda items, recorded discussion and action items — and carries forward the items nobody closed.",
  category: "drafter",
  scope: "project",
  inputs: ["meeting", "agenda items", "action items"],
  outputs: ["minutes draft"],
  dataCategories: ["correspondence", "project_metadata"],
  targetTypes: ["meeting_minutes"],
  consequential: false,
  schedulable: false,
  requireCitations: true,
  maxTokens: 20_000,
  schema: minutesSchema,
  system: [
    "You are the ConstructOS meeting minutes drafter.",
    "Write minutes strictly from the agenda items and their recorded discussion. Do not invent attendance, statements or decisions.",
    "An agenda item with no recorded discussion is minuted as 'no discussion recorded', which is the truth.",
    "carriedForward lists open items that were not closed at this meeting.",
    outputContract(
      '{"minutes":string,"decisions":[string],"actions":[{"title":string,"owner":string,"dueDate":string,"citations":[{"type":string,"id":string}]}],"carriedForward":[string],"citations":[{"type":string,"id":string}],"confidence":number}',
    ),
  ].join("\n"),

  async gather(ctx: AgentContext): Promise<GatherResult> {
    if (!ctx.projectId) return { context: "", inputRefs: [], skip: "Needs a project" };
    const meetingId = paramString(ctx, "meetingId");
    const [meeting] = meetingId
      ? await ctx.db
          .select()
          .from(meetings)
          .where(
            and(
              eq(meetings.id, meetingId),
              eq(meetings.companyId, ctx.companyId),
              eq(meetings.projectId, ctx.projectId),
            ),
          )
          .limit(1)
      : await ctx.db
          .select()
          .from(meetings)
          .where(and(eq(meetings.companyId, ctx.companyId), eq(meetings.projectId, ctx.projectId)))
          .orderBy(desc(meetings.number))
          .limit(1);
    if (!meeting) return { context: "", inputRefs: [], skip: "No meeting to minute" };

    const [agenda, actions] = await Promise.all([
      ctx.db
        .select()
        .from(meetingAgendaItems)
        .where(
          and(
            eq(meetingAgendaItems.companyId, ctx.companyId),
            eq(meetingAgendaItems.meetingId, meeting.id),
          ),
        )
        .orderBy(meetingAgendaItems.position)
        .limit(60),
      ctx.db
        .select()
        .from(meetingActionItems)
        .where(
          and(
            eq(meetingActionItems.companyId, ctx.companyId),
            eq(meetingActionItems.meetingId, meeting.id),
          ),
        )
        .limit(60),
    ]);

    const rows: EvidenceRow[] = [
      {
        type: "meeting",
        id: meeting.id,
        label: `Meeting #${meeting.number} ${meeting.meetingType} — ${clip(meeting.title, 130)}`,
        detail: [
          `Scheduled ${isoDay(meeting.scheduledStart)}; status ${meeting.status}; attendees recorded ${meeting.attendeeCount ?? 0}`,
          `Quorum required ${meeting.quorumRequired ? "yes" : "no"}; quorum met ${meeting.quorumMet ? "yes" : "no"}`,
          `Existing minutes body: ${clip(meeting.minutesBody, 1500)}`,
        ].join("\n"),
      },
    ];
    for (const a of agenda) {
      rows.push({
        type: "meeting_agenda_item",
        id: a.id,
        label: `Agenda ${a.itemNumber ?? a.position} — ${clip(a.title, 130)}`,
        detail: [
          `Status ${a.status}; category ${a.category ?? "none"}; carried ${a.carryCount ?? 0} time(s)`,
          `Description: ${clip(a.description, 600)}`,
          `Discussion recorded: ${clip(a.discussion, 1500)}`,
        ].join("\n"),
      });
    }
    for (const a of actions) {
      rows.push({
        type: "meeting_action_item",
        id: a.id,
        label: `Action ${a.reference ?? a.number} — ${clip(a.title, 130)}`,
        detail: `Status ${a.status}; owner ${a.ownerName ?? a.ownerId ?? "unassigned"}; due ${isoDay(a.dueDate)}`,
      });
    }
    return {
      context: renderEvidence(rows),
      inputRefs: refsOf(rows),
      facts: { meetingId: meeting.id },
    };
  },

  propose(output, ctx, gathered): ProposalDraft[] {
    const meetingId = typeof gathered.facts?.["meetingId"] === "string"
      ? (gathered.facts["meetingId"] as string)
      : null;
    return [
      {
        targetType: "meeting_minutes" as const,
        targetId: meetingId,
        summary: `Minutes draft: ${output.decisions.length} decision(s), ${output.actions.length} action(s)`,
        proposal: { ...output, projectId: ctx.projectId },
        confidence: output.confidence,
      },
    ];
  },

  summarise(output) {
    return `Minutes drafted with ${output.decisions.length} decision(s) and ${output.actions.length} action(s)`;
  },
});

/* ================================================================== */
/* incident_classifier                                                 */
/* ================================================================== */

const incidentClassificationSchema = z.object({
  reportable: z.boolean(),
  regimes: z.array(z.string().max(40)).max(10).default([]).catch([]),
  riddorCategory: z.string().max(80).nullable().optional(),
  oshaCaseType: z.string().max(80).nullable().optional(),
  reportingDeadlineNote: z.string().max(1000).optional(),
  rootCauseHints: z
    .array(z.object({ hypothesis: z.string().max(600), evidenceNeeded: z.string().max(600) }))
    .max(15)
    .default([])
    .catch([]),
  rationale: z.string().min(1).max(4000),
  citations: citationList,
  confidence: requiredConfidence,
});

export const incidentClassifier = defineAgent({
  kind: "incident_classifier",
  name: "Incident classifier",
  description:
    "Assesses whether an incident is reportable under RIDDOR or OSHA from the recorded facts, and offers root-cause hypotheses with the evidence each would need.",
  category: "reviewer",
  scope: "project",
  inputs: ["safety incident"],
  outputs: ["reportability assessment", "root-cause hypotheses"],
  dataCategories: ["safety_records", "worker_records"],
  targetTypes: ["incident_classification"],
  consequential: false,
  schedulable: false,
  requireCitations: true,
  schema: incidentClassificationSchema,
  system: [
    "You are the ConstructOS incident classifier.",
    "Assess reportability from the RECORDED facts only: injury type, treatment level, lost time, fatality, dangerous occurrence, environmental release.",
    "Your assessment is advisory and never replaces the duty holder's decision. Where a fact needed to decide is missing, say so in the rationale and set reportable=false with an explicit statement that it could not be determined.",
    "rootCauseHints are HYPOTHESES with the evidence that would test each. Never assert a cause.",
    outputContract(
      '{"reportable":boolean,"regimes":[string],"riddorCategory":string|null,"oshaCaseType":string|null,"reportingDeadlineNote":string,"rootCauseHints":[{"hypothesis":string,"evidenceNeeded":string}],"rationale":string,"citations":[{"type":string,"id":string}],"confidence":number}',
    ),
  ].join("\n"),

  async gather(ctx: AgentContext): Promise<GatherResult> {
    if (!ctx.projectId) return { context: "", inputRefs: [], skip: "Needs a project" };
    const incidentId = paramString(ctx, "incidentId");
    const [incident] = incidentId
      ? await ctx.db
          .select()
          .from(safetyIncidents)
          .where(
            and(
              eq(safetyIncidents.id, incidentId),
              eq(safetyIncidents.companyId, ctx.companyId),
              eq(safetyIncidents.projectId, ctx.projectId),
            ),
          )
          .limit(1)
      : await ctx.db
          .select()
          .from(safetyIncidents)
          .where(
            and(
              eq(safetyIncidents.companyId, ctx.companyId),
              eq(safetyIncidents.projectId, ctx.projectId),
            ),
          )
          .orderBy(desc(safetyIncidents.number))
          .limit(1);
    if (!incident) return { context: "", inputRefs: [], skip: "No incident to classify" };

    const rows: EvidenceRow[] = [
      {
        type: "safety_incident",
        id: incident.id,
        label: `Incident #${incident.number} ${incident.incidentType} (${incident.severity}) — ${clip(incident.title, 130)}`,
        detail: [
          `Occurred ${isoDay(incident.occurredAt)}; reported ${isoDay(incident.reportedAt)}; delay ${incident.reportingDelayHours ?? "not computed"} h`,
          `Treatment level: ${incident.treatmentLevel ?? "not recorded"}; body part ${incident.bodyPart ?? "not recorded"}; nature ${incident.injuryNature ?? "not recorded"}`,
          `Lost time: ${incident.isLostTime ? `yes (${incident.lostTimeDays ?? "?"} days)` : "no"}; restricted duty ${incident.restrictedDutyDays ?? 0} days; fatality ${incident.isFatality ? "YES" : "no"}`,
          `Mechanism: ${clip(incident.mechanism, 400)}`,
          `Environmental release: ${clip(incident.environmentalReleaseDescription, 300)}`,
          `Existing reportability flag: ${incident.isReportable ?? "not set"}; regimes ${clip(JSON.stringify(incident.reportableRegimes ?? []), 200)}`,
          `Description: ${clip(incident.description, 2000)}`,
        ].join("\n"),
      },
    ];
    return {
      context: renderEvidence(rows),
      inputRefs: refsOf(rows),
      facts: { incidentId: incident.id },
    };
  },

  propose(output, ctx, gathered): ProposalDraft[] {
    const incidentId = typeof gathered.facts?.["incidentId"] === "string"
      ? (gathered.facts["incidentId"] as string)
      : null;
    return [
      {
        targetType: "incident_classification" as const,
        targetId: incidentId,
        summary: output.reportable
          ? `Assessed REPORTABLE under ${output.regimes.join(", ") || "an unnamed regime"}`
          : "Assessed not reportable on the recorded facts",
        proposal: { ...output, projectId: ctx.projectId },
        confidence: output.confidence,
      },
    ];
  },

  summarise(output) {
    return `${output.reportable ? "Reportable" : "Not reportable"} on the record; ${output.rootCauseHints.length} root-cause hypothesis(es)`;
  },
});

/* ================================================================== */
/* spec_compliance_checker                                             */
/* ================================================================== */

const specComplianceSchema = z.object({
  compliant: z.enum(["yes", "no", "cannot_determine"]).catch("cannot_determine"),
  deviations: z
    .array(
      z.object({
        clause: z.string().max(200),
        requirement: z.string().max(1500),
        submitted: z.string().max(1500),
        severity: z.enum(["low", "medium", "high"]).catch("medium"),
        citations: citationList,
      }),
    )
    .max(30)
    .default([])
    .catch([]),
  missingItems: z.array(z.string().max(400)).max(30).default([]).catch([]),
  rationale: z.string().min(1).max(6000),
  citations: citationList,
  confidence: requiredConfidence,
});

export const specComplianceChecker = defineAgent({
  kind: "spec_compliance_checker",
  name: "Spec compliance checker",
  description:
    "Checks a submittal against the clause text of the specification section that governs it, and lists the required items it does not contain.",
  category: "reviewer",
  scope: "project",
  inputs: ["submittal", "specification section text"],
  outputs: ["deviations", "missing items"],
  dataCategories: ["specification_text", "field_records"],
  targetTypes: ["spec_compliance"],
  consequential: false,
  schedulable: false,
  requireCitations: true,
  maxTokens: 12_000,
  schema: specComplianceSchema,
  system: [
    "You are the ConstructOS specification compliance checker.",
    "Compare the submittal against the specification clause text supplied. Only the supplied text governs.",
    'If no clause text was supplied, compliant MUST be "cannot_determine" and the rationale must say the specification text was not available. Do not judge a submittal against a section you were not given.',
    outputContract(
      '{"compliant":"yes"|"no"|"cannot_determine","deviations":[{"clause":string,"requirement":string,"submitted":string,"severity":string,"citations":[{"type":string,"id":string}]}],"missingItems":[string],"rationale":string,"citations":[{"type":string,"id":string}],"confidence":number}',
    ),
  ].join("\n"),

  async gather(ctx: AgentContext): Promise<GatherResult> {
    if (!ctx.projectId) return { context: "", inputRefs: [], skip: "Needs a project" };
    const submittalId = paramString(ctx, "submittalId");
    const [submittal] = submittalId
      ? await ctx.db
          .select()
          .from(submittals)
          .where(
            and(
              eq(submittals.id, submittalId),
              eq(submittals.companyId, ctx.companyId),
              eq(submittals.projectId, ctx.projectId),
            ),
          )
          .limit(1)
      : await ctx.db
          .select()
          .from(submittals)
          .where(
            and(
              eq(submittals.companyId, ctx.companyId),
              eq(submittals.projectId, ctx.projectId),
              isNotNull(submittals.specSection),
            ),
          )
          .orderBy(desc(submittals.number))
          .limit(1);
    if (!submittal) return { context: "", inputRefs: [], skip: "No submittal to check" };

    const specRows = submittal.specSection
      ? await ctx.db
          .select({
            sectionId: specSections.id,
            code: specSections.code,
            title: specSections.title,
            text: specSectionRevisions.extractedText,
          })
          .from(specSections)
          .leftJoin(
            specSectionRevisions,
            eq(specSectionRevisions.id, specSections.currentRevisionId),
          )
          .where(
            and(
              eq(specSections.companyId, ctx.companyId),
              eq(specSections.projectId, ctx.projectId),
              eq(specSections.code, submittal.specSection),
            ),
          )
          .limit(3)
      : [];

    const rows: EvidenceRow[] = [
      {
        type: "submittal",
        id: submittal.id,
        label: `Submittal #${submittal.number} rev ${submittal.revision} — ${clip(submittal.title, 130)}`,
        detail: [
          `Type ${submittal.submittalType}; spec section ${submittal.specSection ?? "(none)"}; status ${submittal.status}`,
          `Response code ${submittal.responseCode ?? "none"}; attachments ${(submittal.fileIds ?? []).length}`,
          `Required on site ${isoDay(submittal.requiredOnSite)}`,
        ].join("\n"),
      },
    ];
    for (const s of specRows) {
      rows.push({
        type: "spec_section",
        id: s.sectionId,
        label: `Spec section ${s.code} — ${s.title}`,
        detail: s.text ? clip(s.text, 8000) : "(no extracted clause text recorded for this section)",
      });
    }
    const haveText = specRows.some((s) => Boolean(s.text));
    return {
      context: `${haveText ? "" : "NOTE: no specification clause text is available for this submittal.\n\n"}${renderEvidence(rows)}`,
      inputRefs: refsOf(rows),
      facts: { submittalId: submittal.id, haveSpecText: haveText },
    };
  },

  propose(output, ctx, gathered): ProposalDraft[] {
    const submittalId = typeof gathered.facts?.["submittalId"] === "string"
      ? (gathered.facts["submittalId"] as string)
      : null;
    return [
      {
        targetType: "spec_compliance" as const,
        targetId: submittalId,
        summary: `Spec compliance: ${output.compliant} (${output.deviations.length} deviation(s), ${output.missingItems.length} missing item(s))`,
        proposal: { ...output, projectId: ctx.projectId },
        confidence: output.confidence,
      },
    ];
  },

  summarise(output) {
    return `Compliance ${output.compliant}; ${output.deviations.length} deviation(s)`;
  },
});

/* ================================================================== */
/* change_impact_analyst                                               */
/* ================================================================== */

const changeImpactSchema = z.object({
  costBasis: z.string().min(1).max(4000),
  scheduleImpactDays: z.number().int().min(0).max(10_000).nullable().optional(),
  scheduleBasis: z.string().max(3000).optional(),
  entitlementNotes: z.string().max(4000).optional(),
  risks: z.array(z.string().max(500)).max(20).default([]).catch([]),
  unavailable: z.array(z.string().max(300)).max(20).default([]).catch([]),
  citations: citationList,
  confidence: requiredConfidence,
});

export const changeImpactAnalyst = defineAgent({
  kind: "change_impact_analyst",
  name: "Change impact analyst",
  description:
    "Assesses what a change event actually costs and delays, from the budget lines and commitments it touches, and states which figures the record does not hold.",
  category: "analyst",
  scope: "project",
  inputs: ["change event", "budget line items", "commitments", "schedule tasks"],
  outputs: ["impact assessment"],
  dataCategories: ["financial", "schedule", "contract_terms"],
  targetTypes: ["change_impact"],
  consequential: false,
  schedulable: false,
  requireCitations: true,
  schema: changeImpactSchema,
  system: [
    "You are the ConstructOS change impact analyst.",
    "Assess the cost and time impact of the change event from the rows supplied. Every number must be traceable to one of them.",
    "scheduleImpactDays is null unless a supplied row states it. Do not derive a duration from a cost.",
    "Anything a proper assessment needs and the record does not hold goes in 'unavailable'.",
    outputContract(
      '{"costBasis":string,"scheduleImpactDays":number|null,"scheduleBasis":string,"entitlementNotes":string,"risks":[string],"unavailable":[string],"citations":[{"type":string,"id":string}],"confidence":number}',
    ),
  ].join("\n"),

  async gather(ctx: AgentContext): Promise<GatherResult> {
    if (!ctx.projectId) return { context: "", inputRefs: [], skip: "Needs a project" };
    const changeId = paramString(ctx, "changeEventId");
    const [change] = changeId
      ? await ctx.db
          .select()
          .from(changeEvents)
          .where(
            and(
              eq(changeEvents.id, changeId),
              eq(changeEvents.companyId, ctx.companyId),
              eq(changeEvents.projectId, ctx.projectId),
            ),
          )
          .limit(1)
      : await ctx.db
          .select()
          .from(changeEvents)
          .where(
            and(
              eq(changeEvents.companyId, ctx.companyId),
              eq(changeEvents.projectId, ctx.projectId),
            ),
          )
          .orderBy(desc(changeEvents.number))
          .limit(1);
    if (!change) return { context: "", inputRefs: [], skip: "No change event to assess" };

    const [lines, commitmentRows] = await Promise.all([
      ctx.db
        .select()
        .from(budgetLineItems)
        .where(
          and(
            eq(budgetLineItems.companyId, ctx.companyId),
            eq(budgetLineItems.projectId, ctx.projectId),
          ),
        )
        .limit(20),
      ctx.db
        .select()
        .from(commitments)
        .where(
          and(eq(commitments.companyId, ctx.companyId), eq(commitments.projectId, ctx.projectId)),
        )
        .orderBy(desc(commitments.number))
        .limit(10),
    ]);

    const rows: EvidenceRow[] = [
      {
        type: "change_event",
        id: change.id,
        label: `Change event ${change.reference ?? change.number} — ${clip(change.title, 130)}`,
        detail: [
          `Status ${change.status}; type ${change.eventType ?? "unstated"}; reason ${change.reason ?? "unstated"}; scope ${change.scope ?? "unstated"}`,
          `Origin ${change.originType ?? "none"}:${change.originId ?? "-"}`,
          `ROM ${money(change.roughOrderOfMagnitude)}; estimated ${money(change.estimatedCost)}; latest ${money(change.latestCost)}; approved revenue ${money(change.approvedRevenue)}`,
          `Schedule impact recorded: ${change.scheduleImpactDays ?? "not stated"} days`,
          `Description: ${clip(change.description, 2500)}`,
        ].join("\n"),
      },
    ];
    for (const l of lines) {
      rows.push({
        type: "budget_line_item",
        id: l.id,
        label: `Budget line ${l.costCode ?? l.id} — ${clip(l.description, 90)}`,
        detail: `Revised ${money(l.revisedBudget)}; committed ${money(l.committedCost)}; JTD ${money(l.jobToDateCosts)}; pending changes ${money(l.pendingBudgetChanges)}`,
      });
    }
    for (const c of commitmentRows) {
      rows.push({
        type: "commitment",
        id: c.id,
        label: `Commitment ${c.reference ?? c.number} (${c.currency}) — ${clip(c.title, 90)}`,
        detail: `Revised ${money(c.revisedCommitmentSum)}; pending changes ${money(c.pendingChangeSum)}; status ${c.status}`,
      });
    }
    return {
      context: renderEvidence(rows),
      inputRefs: refsOf(rows),
      facts: { changeEventId: change.id },
    };
  },

  propose(output, ctx, gathered): ProposalDraft[] {
    const changeEventId = typeof gathered.facts?.["changeEventId"] === "string"
      ? (gathered.facts["changeEventId"] as string)
      : null;
    return [
      {
        targetType: "change_impact" as const,
        targetId: changeEventId,
        summary: `Change impact: ${
          output.scheduleImpactDays === null || output.scheduleImpactDays === undefined
            ? "no schedule impact stated by the record"
            : `${output.scheduleImpactDays} day(s)`
        }, ${output.unavailable.length} figure(s) unavailable`,
        proposal: { ...output, projectId: ctx.projectId },
        confidence: output.confidence,
      },
    ];
  },

  summarise(output) {
    return `Impact assessed; ${output.risks.length} risk(s), ${output.unavailable.length} unavailable figure(s)`;
  },
});

/* ================================================================== */
/* bid_levelling_analyst                                               */
/* ================================================================== */

const bidLevellingSchema = z.object({
  scopeGaps: z
    .array(
      z.object({
        description: z.string().min(1).max(1000),
        affectedVendors: z.array(z.string().max(128)).max(20).default([]).catch([]),
        citations: citationList,
      }),
    )
    .max(30)
    .default([])
    .catch([]),
  outliers: z
    .array(
      z.object({
        submissionId: z.string().max(128),
        observation: z.string().min(1).max(1000),
        severity: z.enum(["low", "medium", "high"]).catch("medium"),
        citations: citationList,
      }),
    )
    .max(30)
    .default([])
    .catch([]),
  comparabilityNotes: z.string().max(4000).optional(),
  citations: citationList,
  confidence: requiredConfidence,
});

export const bidLevellingAnalyst = defineAgent({
  kind: "bid_levelling_analyst",
  name: "Bid levelling analyst",
  description:
    "Levels the bids on a package: what one bidder priced and another excluded, which rates sit outside the field, and whether the submissions are comparable at all.",
  category: "analyst",
  scope: "project",
  inputs: ["bid package", "bid submissions", "submission lines"],
  outputs: ["scope gaps", "outliers"],
  dataCategories: ["vendor_records", "financial"],
  targetTypes: ["bid_levelling"],
  consequential: false,
  schedulable: false,
  requireCitations: true,
  maxTokens: 12_000,
  schema: bidLevellingSchema,
  system: [
    "You are the ConstructOS bid levelling analyst.",
    "Find what makes the submissions NOT comparable: scope one bidder included and another excluded, qualifications, differing programme durations, alternates priced by some and not others.",
    "Name a rate as an outlier only against the other supplied rates for the same item; never against outside market knowledge.",
    "You do not recommend an award. Levelling is preparation for a human decision.",
    outputContract(
      '{"scopeGaps":[{"description":string,"affectedVendors":[string],"citations":[{"type":string,"id":string}]}],"outliers":[{"submissionId":string,"observation":string,"severity":string,"citations":[{"type":string,"id":string}]}],"comparabilityNotes":string,"citations":[{"type":string,"id":string}],"confidence":number}',
    ),
  ].join("\n"),

  async gather(ctx: AgentContext): Promise<GatherResult> {
    if (!ctx.projectId) return { context: "", inputRefs: [], skip: "Needs a project" };
    const packageId = paramString(ctx, "packageId");
    const [pkg] = packageId
      ? await ctx.db
          .select()
          .from(bidPackages)
          .where(
            and(
              eq(bidPackages.id, packageId),
              eq(bidPackages.companyId, ctx.companyId),
              eq(bidPackages.projectId, ctx.projectId),
            ),
          )
          .limit(1)
      : await ctx.db
          .select()
          .from(bidPackages)
          .where(
            and(eq(bidPackages.companyId, ctx.companyId), eq(bidPackages.projectId, ctx.projectId)),
          )
          .orderBy(desc(bidPackages.number))
          .limit(1);
    if (!pkg) return { context: "", inputRefs: [], skip: "No bid package to level" };

    const subs = await ctx.db
      .select()
      .from(bidSubmissions)
      .where(
        and(eq(bidSubmissions.companyId, ctx.companyId), eq(bidSubmissions.packageId, pkg.id)),
      )
      .limit(15);
    if (subs.length < 2) {
      return {
        context: "",
        inputRefs: [],
        skip: `Package ${pkg.reference ?? pkg.number} has ${subs.length} submission(s); levelling needs at least two`,
      };
    }
    const lines = await ctx.db
      .select()
      .from(bidSubmissionLines)
      .where(
        and(
          eq(bidSubmissionLines.companyId, ctx.companyId),
          inArray(
            bidSubmissionLines.submissionId,
            subs.map((s) => s.id),
          ),
        ),
      )
      .limit(150);

    const rows: EvidenceRow[] = [
      {
        type: "bid_package",
        id: pkg.id,
        label: `Bid package ${pkg.reference ?? pkg.number} — ${clip(pkg.title, 130)}`,
        detail: [
          `Status ${pkg.status}; currency ${pkg.currency}; engineer's estimate ${money(pkg.engineersEstimate)}`,
          `Evaluation method ${pkg.evaluationMethod ?? "unstated"}; price weight ${pkg.priceWeight ?? "n/a"}`,
          `Scope: ${clip(pkg.scopeDescription, 1500)}`,
        ].join("\n"),
      },
    ];
    for (const s of subs) {
      const own = lines.filter((l) => l.submissionId === s.id);
      rows.push({
        type: "bid_submission",
        id: s.id,
        label: `Submission ${s.reference ?? s.id} from vendor ${s.vendorId}`,
        detail: [
          `Total ${money(s.totalAmount)} ${s.currency}; base ${money(s.baseBidAmount)}; alternates ${money(s.alternatesTotal)}; provisional sums ${money(s.provisionalSumsTotal)}`,
          `Programme ${s.proposedProgrammeWeeks ?? "not stated"} weeks; late ${s.isLate ? "YES" : "no"}; compliance ${s.complianceStatus ?? "not assessed"}`,
          `Exclusions: ${clip(s.exclusions, 700)}`,
          `Qualifications: ${clip(s.qualifications, 700)}`,
          `Priced lines (${own.length}): ${own
            .slice(0, 25)
            .map((l) => `${l.itemCode ?? l.position}:${clip(l.description, 40)}=${money(l.unitRate)}/${l.unit ?? "unit"}${l.isExcluded ? " [EXCLUDED]" : ""}`)
            .join("; ")}`,
        ].join("\n"),
      });
    }
    return {
      context: renderEvidence(rows),
      inputRefs: refsOf(rows),
      contradictions: subs.length,
      facts: { packageId: pkg.id },
    };
  },

  propose(output, ctx, gathered): ProposalDraft[] {
    const packageId = typeof gathered.facts?.["packageId"] === "string"
      ? (gathered.facts["packageId"] as string)
      : null;
    return [
      {
        targetType: "bid_levelling" as const,
        targetId: packageId,
        summary: `${output.scopeGaps.length} scope gap(s), ${output.outliers.length} outlier(s)`,
        proposal: { ...output, projectId: ctx.projectId },
        confidence: output.confidence,
      },
    ];
  },

  summarise(output) {
    return `Levelled: ${output.scopeGaps.length} scope gap(s), ${output.outliers.length} rate outlier(s)`;
  },
});

export const deliveryAgents = [
  riskMonitor,
  costForecaster,
  scheduleRiskAnalyst,
  meetingMinutesDrafter,
  incidentClassifier,
  specComplianceChecker,
  changeImpactAnalyst,
  bidLevellingAnalyst,
];
