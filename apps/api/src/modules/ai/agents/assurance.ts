/**
 * Assurance-side agents (Vol II X #1011–#1014, #1017).
 *
 *   evidence_sufficiency_scorer  does the evidence behind each assertion
 *                                actually test it, and who authored it (#1017)
 *   counterfactual_analyst       what would the record look like if the
 *                                proposition were false (#1013)
 *   anomaly_explainer            explains an open signal in terms of the
 *                                records it points at, benign case first
 *                                (#1012)
 *   integrity_monitor            assembles a review memo over a signal and its
 *                                linked evidence, and REFUSES to conclude when
 *                                the evidence is not independent (#1011)
 *   multi_document_reasoner      answers across drawings, specs and RFIs and
 *                                names the conflicts between them (#1014)
 *
 * None of these dispositions a signal. Segregation of duties is the point of
 * the assurance layer: an agent that could close its own finding would be the
 * assertion and the evidence at once.
 */
import { and, desc, eq, ilike, inArray, or } from "drizzle-orm";
import { z } from "zod";
import {
  assertions,
  drawingRevisions,
  drawingSheets,
  entityRelationships,
  evidence,
  reconciliations,
  rfis,
  signals,
  specSectionRevisions,
  specSections,
} from "@constructos/db";
import { escapeLike } from "../service.js";
import { citationList, outputContract, requiredConfidence, severityEnum } from "./schemas.js";
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

/* ================================================================== */
/* evidence_sufficiency_scorer (#1017)                                 */
/* ================================================================== */

const sufficiencySchema = z.object({
  assessments: z
    .array(
      z.object({
        assertionId: z.string().min(1).max(128),
        sufficiency: z.enum(["sufficient", "partial", "insufficient"]).catch("insufficient"),
        independenceConcern: z.boolean().default(false).catch(false),
        missingEvidence: z.array(z.string().max(400)).max(15).default([]).catch([]),
        rationale: z.string().min(1).max(3000),
        citations: citationList,
      }),
    )
    .max(40)
    .default([])
    .catch([]),
  citations: citationList,
  confidence: requiredConfidence,
});

export const evidenceSufficiencyScorer = defineAgent({
  kind: "evidence_sufficiency_scorer",
  name: "Evidence sufficiency scorer",
  description:
    "For each assertion on the project, judges whether the evidence attached actually tests it, and flags evidence authored by the same party that made the claim.",
  category: "reviewer",
  scope: "project",
  inputs: ["assertions", "evidence", "reconciliations"],
  outputs: ["evidence assessments"],
  dataCategories: ["assurance_records"],
  targetTypes: ["evidence_assessment"],
  consequential: false,
  schedulable: true,
  requireCitations: true,
  schema: sufficiencySchema,
  system: [
    "You are the ConstructOS evidence sufficiency scorer.",
    "The platform's design rule: an assertion and the evidence that tests it must not come from the same actor through the same pathway.",
    "Judge sufficiency on: does the evidence measure the same thing the assertion claims, is it contemporaneous, and is its source independent of the claimant.",
    "Set independenceConcern=true whenever the evidence's source or submitter is the claimant, or the provenance does not say.",
    outputContract(
      '{"assessments":[{"assertionId":string,"sufficiency":"sufficient"|"partial"|"insufficient","independenceConcern":boolean,"missingEvidence":[string],"rationale":string,"citations":[{"type":string,"id":string}]}],"citations":[{"type":string,"id":string}],"confidence":number}',
    ),
  ].join("\n"),

  async gather(ctx: AgentContext): Promise<GatherResult> {
    if (!ctx.projectId) return { context: "", inputRefs: [], skip: "Needs a project" };
    const claims = await ctx.db
      .select()
      .from(assertions)
      .where(
        and(eq(assertions.companyId, ctx.companyId), eq(assertions.projectId, ctx.projectId)),
      )
      .orderBy(desc(assertions.assertedAt))
      .limit(25);
    if (claims.length === 0) {
      return { context: "", inputRefs: [], skip: "No assertions recorded on this project" };
    }
    const recs = await ctx.db
      .select()
      .from(reconciliations)
      .where(
        and(
          eq(reconciliations.companyId, ctx.companyId),
          eq(reconciliations.projectId, ctx.projectId),
          inArray(
            reconciliations.assertionId,
            claims.map((c) => c.id),
          ),
        ),
      )
      .limit(60);
    const evidenceIds = [
      ...new Set(
        recs.flatMap((r) => (r.evidenceIds ?? []).filter((id): id is string => typeof id === "string")),
      ),
    ].slice(0, 60);
    const evidenceRows = evidenceIds.length
      ? await ctx.db
          .select()
          .from(evidence)
          .where(and(eq(evidence.companyId, ctx.companyId), inArray(evidence.id, evidenceIds)))
      : [];

    const rows: EvidenceRow[] = [];
    for (const c of claims) {
      rows.push({
        type: "assertion",
        id: c.id,
        label: `Assertion ${c.kind} by ${c.claimantKind} ${c.claimantId ?? "(unknown)"}`,
        detail: [
          `Value: ${c.value ?? "not stated"} ${c.unit ?? ""}`.trim(),
          `Basis: ${clip(c.basis, 500)}`,
          `Contract ref: ${c.contractRef ?? "(none)"}; source ${c.sourceType ?? "(none)"}:${c.sourceId ?? "-"}`,
          `Asserted at ${isoDay(c.assertedAt)}`,
        ].join("\n"),
      });
    }
    for (const r of recs) {
      rows.push({
        type: "reconciliation",
        id: r.id,
        label: `Reconciliation of assertion ${r.assertionId} by method ${r.method}`,
        detail: `Result ${r.result}; variance ${r.variance ?? "n/a"} (${r.variancePercent ?? "n/a"}%); confidence ${r.confidence ?? "n/a"}; disposition ${r.disposition}`,
      });
    }
    for (const e of evidenceRows) {
      rows.push({
        type: "evidence",
        id: e.id,
        label: `Evidence ${e.kind} from ${e.source}`,
        detail: [
          `Captured ${isoDay(e.capturedAt)}; independence score ${e.independenceScore ?? "not scored"}`,
          `Provenance: ${clip(JSON.stringify(e.provenance ?? {}), 400)}`,
          `Submitted by: ${e.submittedBy ?? "(unrecorded)"}`,
        ].join("\n"),
      });
    }

    return {
      context: renderEvidence(rows),
      inputRefs: refsOf(rows),
      contradictions: recs.filter((r) => r.result !== "match").length,
    };
  },

  propose(output, ctx): ProposalDraft[] {
    if (output.assessments.length === 0) return [];
    const weak = output.assessments.filter((a) => a.sufficiency !== "sufficient");
    return [
      {
        targetType: "evidence_assessment" as const,
        targetId: null,
        summary: `${weak.length} of ${output.assessments.length} assertion(s) not sufficiently evidenced`,
        proposal: { ...output, projectId: ctx.projectId },
        confidence: output.confidence,
        signal:
          weak.some((a) => a.independenceConcern)
            ? {
                detector: "agent_evidence_independence",
                severity: "high",
                title: "Assertions evidenced by their own claimant",
                explanation: weak
                  .filter((a) => a.independenceConcern)
                  .map((a) => `${a.assertionId}: ${a.rationale}`)
                  .join("\n")
                  .slice(0, 4000),
                evidenceRefs: output.citations,
              }
            : undefined,
      },
    ];
  },

  summarise(output) {
    const insufficient = output.assessments.filter((a) => a.sufficiency === "insufficient").length;
    return `${output.assessments.length} assertion(s) assessed, ${insufficient} insufficiently evidenced`;
  },
});

/* ================================================================== */
/* counterfactual_analyst (#1013)                                      */
/* ================================================================== */

const counterfactualSchema = z.object({
  proposition: z.string().min(1).max(1000),
  ifTrue: z.string().min(1).max(4000),
  ifFalse: z.string().min(1).max(4000),
  discriminatingEvidence: z.array(z.string().max(500)).max(20).default([]).catch([]),
  whichIsSupported: z.enum(["true", "false", "undetermined"]).catch("undetermined"),
  assumptions: z.array(z.string().max(400)).max(20).default([]).catch([]),
  citations: citationList,
  confidence: requiredConfidence,
});

export const counterfactualAnalyst = defineAgent({
  kind: "counterfactual_analyst",
  name: "Counterfactual analyst",
  description:
    "States what the record WOULD look like if a proposition were true and if it were false, then names the evidence that would tell the two apart.",
  category: "analyst",
  scope: "project",
  inputs: ["signal", "assertions", "reconciliations"],
  outputs: ["counterfactual analysis"],
  dataCategories: ["assurance_records"],
  targetTypes: ["counterfactual"],
  consequential: false,
  schedulable: false,
  requireCitations: true,
  schema: counterfactualSchema,
  system: [
    "You are the ConstructOS counterfactual analyst.",
    "Given a proposition and the records around it, describe the world in which it is TRUE and the world in which it is FALSE, in terms of what the project's records would contain in each.",
    "Then list the discriminating evidence: the records that exist in one world and not the other. That list is the point of the exercise.",
    "whichIsSupported must be 'undetermined' unless the supplied records actually discriminate.",
    outputContract(
      '{"proposition":string,"ifTrue":string,"ifFalse":string,"discriminatingEvidence":[string],"whichIsSupported":"true"|"false"|"undetermined","assumptions":[string],"citations":[{"type":string,"id":string}],"confidence":number}',
    ),
  ].join("\n"),

  async gather(ctx: AgentContext): Promise<GatherResult> {
    if (!ctx.projectId) return { context: "", inputRefs: [], skip: "Needs a project" };
    const signalId = paramString(ctx, "signalId");
    const proposition = paramString(ctx, "proposition");
    const [signal] = signalId
      ? await ctx.db
          .select()
          .from(signals)
          .where(
            and(
              eq(signals.id, signalId),
              eq(signals.companyId, ctx.companyId),
              eq(signals.projectId, ctx.projectId),
            ),
          )
          .limit(1)
      : await ctx.db
          .select()
          .from(signals)
          .where(
            and(
              eq(signals.companyId, ctx.companyId),
              eq(signals.projectId, ctx.projectId),
              inArray(signals.disposition, ["new", "under_review"]),
            ),
          )
          .orderBy(desc(signals.createdAt))
          .limit(1);
    if (!signal && !proposition) {
      return {
        context: "",
        inputRefs: [],
        skip: "Supply a signalId or a proposition, or raise a signal first",
      };
    }

    const recs = await ctx.db
      .select()
      .from(reconciliations)
      .where(
        and(
          eq(reconciliations.companyId, ctx.companyId),
          eq(reconciliations.projectId, ctx.projectId),
        ),
      )
      .orderBy(desc(reconciliations.createdAt))
      .limit(15);

    const rows: EvidenceRow[] = [];
    if (signal) {
      rows.push({
        type: "signal",
        id: signal.id,
        label: `Signal ${signal.detector} (${signal.severity}) — ${clip(signal.title, 150)}`,
        detail: [
          `Confidence ${signal.confidence}; disposition ${signal.disposition}`,
          `Explanation: ${clip(signal.explanation, 2500)}`,
          `Evidence refs: ${clip(JSON.stringify(signal.evidenceRefs ?? []), 800)}`,
        ].join("\n"),
      });
    }
    for (const r of recs) {
      rows.push({
        type: "reconciliation",
        id: r.id,
        label: `Reconciliation ${r.method} — result ${r.result}`,
        detail: `Assertion ${r.assertionId}; variance ${r.variance ?? "n/a"} (${r.variancePercent ?? "n/a"}%); disposition ${r.disposition}; notes ${clip(r.notes, 300)}`,
      });
    }
    const stated =
      proposition ?? (signal ? `${signal.title} — ${signal.detector} fired on this project` : "");

    return {
      context: `PROPOSITION UNDER TEST: ${stated}\n\n${renderEvidence(rows)}`,
      inputRefs: refsOf(rows),
      contradictions: recs.filter((r) => r.result === "match").length,
      facts: { signalId: signal?.id ?? null },
    };
  },

  propose(output, ctx, gathered): ProposalDraft[] {
    const signalId = typeof gathered.facts?.["signalId"] === "string"
      ? (gathered.facts["signalId"] as string)
      : null;
    return [
      {
        targetType: "counterfactual" as const,
        targetId: signalId,
        summary: `Counterfactual on "${clip(output.proposition, 120)}" — ${output.whichIsSupported}`,
        proposal: { ...output, projectId: ctx.projectId },
        confidence: output.confidence,
      },
    ];
  },

  summarise(output) {
    return `Counterfactual: ${output.whichIsSupported}; ${output.discriminatingEvidence.length} discriminating record(s) named`;
  },
});

/* ================================================================== */
/* anomaly_explainer (#1012)                                           */
/* ================================================================== */

const anomalyExplanationSchema = z.object({
  explanations: z
    .array(
      z.object({
        signalId: z.string().min(1).max(128),
        benignExplanation: z.string().min(1).max(3000),
        concerningExplanation: z.string().min(1).max(3000),
        severityAssessment: severityEnum,
        recommendedEvidence: z.array(z.string().max(400)).max(15).default([]).catch([]),
        citations: citationList,
      }),
    )
    .max(20)
    .default([])
    .catch([]),
  citations: citationList,
  confidence: requiredConfidence,
});

export const anomalyExplainer = defineAgent({
  kind: "anomaly_explainer",
  name: "Anomaly explainer",
  description:
    "Explains each open signal twice — the benign reading first, then the concerning one — and names the evidence that would settle which it is.",
  category: "analyst",
  scope: "project",
  inputs: ["signals", "reconciliations"],
  outputs: ["signal explanations"],
  dataCategories: ["assurance_records"],
  targetTypes: ["signal_explanation"],
  consequential: true,
  schedulable: true,
  requireCitations: true,
  schema: anomalyExplanationSchema,
  system: [
    "You are the ConstructOS anomaly explainer.",
    "For every supplied signal, give the BENIGN explanation first and in good faith, then the concerning one. A detector firing is not a finding of wrongdoing.",
    "Never assert intent. Name the evidence that would discriminate between the two readings.",
    "You may not disposition a signal; a human reviewer does that.",
    outputContract(
      '{"explanations":[{"signalId":string,"benignExplanation":string,"concerningExplanation":string,"severityAssessment":string,"recommendedEvidence":[string],"citations":[{"type":string,"id":string}]}],"citations":[{"type":string,"id":string}],"confidence":number}',
    ),
  ].join("\n"),

  async gather(ctx: AgentContext): Promise<GatherResult> {
    const scope = ctx.projectId
      ? and(
          eq(signals.companyId, ctx.companyId),
          eq(signals.projectId, ctx.projectId),
          inArray(signals.disposition, ["new", "under_review"]),
        )
      : and(
          eq(signals.companyId, ctx.companyId),
          inArray(signals.disposition, ["new", "under_review"]),
        );
    const open = await ctx.db
      .select()
      .from(signals)
      .where(scope)
      .orderBy(desc(signals.createdAt))
      .limit(12);
    if (open.length === 0) {
      return { context: "", inputRefs: [], skip: "No open signals to explain" };
    }
    const rows: EvidenceRow[] = open.map((s) => ({
      type: "signal",
      id: s.id,
      label: `Signal ${s.detector} (${s.severity}, confidence ${s.confidence}) — ${clip(s.title, 150)}`,
      detail: [
        `Raised ${isoDay(s.createdAt)}; disposition ${s.disposition}`,
        `Explanation as recorded: ${clip(s.explanation, 2000)}`,
        `Evidence refs: ${clip(JSON.stringify(s.evidenceRefs ?? []), 800)}`,
      ].join("\n"),
    }));
    return { context: renderEvidence(rows), inputRefs: refsOf(rows) };
  },

  propose(output, ctx): ProposalDraft[] {
    return output.explanations.map((e) => ({
      targetType: "signal_explanation" as const,
      targetId: e.signalId,
      summary: `Explanation for signal ${e.signalId} (${e.severityAssessment})`,
      proposal: { ...e, projectId: ctx.projectId },
      confidence: output.confidence,
    }));
  },

  summarise(output) {
    return `${output.explanations.length} signal(s) explained`;
  },
});

/* ================================================================== */
/* integrity_monitor (#1011)                                           */
/* ================================================================== */

const integrityMemoSchema = z.object({
  hypothesis: z.string().min(1).max(2000),
  corroborating: z
    .array(z.object({ statement: z.string().max(1500), citations: citationList }))
    .max(20)
    .default([])
    .catch([]),
  contradicting: z
    .array(z.object({ statement: z.string().max(1500), citations: citationList }))
    .max(20)
    .default([])
    .catch([]),
  suggestedDisposition: z
    .enum(["insufficient_evidence", "likely_benign", "warrants_review", "escalate"])
    .catch("insufficient_evidence"),
  followUpEvidence: z.array(z.string().max(400)).max(20).default([]).catch([]),
  independenceAssessment: z.string().max(2000).optional(),
  citations: citationList,
  confidence: requiredConfidence,
});

export const integrityMonitor = defineAgent({
  kind: "integrity_monitor",
  name: "Integrity monitor",
  description:
    "Assembles a review memo over the open signals and the entity graph around them: hypothesis, corroborating and contradicting records, and the evidence still needed. Refuses to conclude when the evidence is not independent.",
  category: "reviewer",
  scope: "both",
  inputs: ["signals", "reconciliations", "entity relationships"],
  outputs: ["integrity memo"],
  dataCategories: ["assurance_records", "vendor_records"],
  targetTypes: ["integrity_memo"],
  consequential: false,
  schedulable: true,
  requireCitations: true,
  maxTokens: 12_000,
  schema: integrityMemoSchema,
  system: [
    "You are the ConstructOS integrity analyst preparing a review memo for an independent reviewer.",
    "State ONE hypothesis. List corroborating records and contradicting records separately, each with its citations; a memo with no contradicting section has not been written properly unless you say why none exists.",
    "suggestedDisposition MUST be 'insufficient_evidence' when the corroborating records all come from the same source or the same actor — independence below that bar is not a conclusion, it is a gap.",
    "You never disposition the signal yourself. Segregation of duties is the platform's design rule.",
    outputContract(
      '{"hypothesis":string,"corroborating":[{"statement":string,"citations":[{"type":string,"id":string}]}],"contradicting":[{"statement":string,"citations":[{"type":string,"id":string}]}],"suggestedDisposition":"insufficient_evidence"|"likely_benign"|"warrants_review"|"escalate","followUpEvidence":[string],"independenceAssessment":string,"citations":[{"type":string,"id":string}],"confidence":number}',
    ),
  ].join("\n"),

  async gather(ctx: AgentContext): Promise<GatherResult> {
    const signalId = paramString(ctx, "signalId");
    const base = ctx.projectId
      ? and(eq(signals.companyId, ctx.companyId), eq(signals.projectId, ctx.projectId))
      : eq(signals.companyId, ctx.companyId);
    const open = signalId
      ? await ctx.db
          .select()
          .from(signals)
          .where(and(base, eq(signals.id, signalId)))
          .limit(1)
      : await ctx.db
          .select()
          .from(signals)
          .where(and(base, inArray(signals.disposition, ["new", "under_review"])))
          .orderBy(desc(signals.createdAt))
          .limit(6);
    if (open.length === 0) {
      return { context: "", inputRefs: [], skip: "No signal to review" };
    }
    const recs = await ctx.db
      .select()
      .from(reconciliations)
      .where(eq(reconciliations.companyId, ctx.companyId))
      .orderBy(desc(reconciliations.createdAt))
      .limit(15);
    const links = await ctx.db
      .select()
      .from(entityRelationships)
      .where(eq(entityRelationships.companyId, ctx.companyId))
      .limit(25);

    const rows: EvidenceRow[] = [];
    for (const s of open) {
      rows.push({
        type: "signal",
        id: s.id,
        label: `Signal ${s.detector} (${s.severity}) — ${clip(s.title, 150)}`,
        detail: `${clip(s.explanation, 2000)}\nEvidence refs: ${clip(JSON.stringify(s.evidenceRefs ?? []), 700)}`,
      });
    }
    for (const r of recs) {
      rows.push({
        type: "reconciliation",
        id: r.id,
        label: `Reconciliation ${r.method} — ${r.result}`,
        detail: `Variance ${r.variance ?? "n/a"} (${r.variancePercent ?? "n/a"}%); disposition ${r.disposition}; ${clip(r.notes, 300)}`,
      });
    }
    for (const l of links) {
      rows.push({
        type: "entity_relationship",
        id: l.id,
        label: `Entity relationship ${l.kind}`,
        detail: clip(JSON.stringify(l), 400),
      });
    }
    return {
      context: renderEvidence(rows),
      inputRefs: refsOf(rows),
      contradictions: recs.filter((r) => r.result === "match").length,
      facts: { signalIds: open.map((s) => s.id) },
    };
  },

  propose(output, ctx, gathered): ProposalDraft[] {
    const ids = Array.isArray(gathered.facts?.["signalIds"])
      ? (gathered.facts["signalIds"] as string[])
      : [];
    return [
      {
        targetType: "integrity_memo" as const,
        targetId: ids[0] ?? null,
        summary: `Integrity memo: ${output.suggestedDisposition} — ${clip(output.hypothesis, 120)}`,
        proposal: { ...output, signalIds: ids, projectId: ctx.projectId },
        confidence: output.confidence,
      },
    ];
  },

  summarise(output) {
    return `Memo suggests ${output.suggestedDisposition}: ${output.corroborating.length} corroborating, ${output.contradicting.length} contradicting`;
  },
});

/* ================================================================== */
/* multi_document_reasoner (#1014)                                     */
/* ================================================================== */

const synthesisSchema = z.object({
  answer: z.string().nullable(),
  conflicts: z
    .array(
      z.object({
        description: z.string().min(1).max(2000),
        citations: citationList,
      }),
    )
    .max(20)
    .default([])
    .catch([]),
  citations: citationList,
  confidence: requiredConfidence,
});

export const multiDocumentReasoner = defineAgent({
  kind: "multi_document_reasoner",
  name: "Multi-document reasoner",
  description:
    "Answers a question across drawings, specification sections and RFIs at once, and names every place where those documents disagree.",
  category: "analyst",
  scope: "project",
  inputs: ["drawing revisions", "specification sections", "RFIs"],
  outputs: ["synthesised answer", "document conflicts"],
  dataCategories: ["drawing_text", "specification_text", "correspondence"],
  targetTypes: ["document_synthesis"],
  consequential: false,
  schedulable: false,
  requireCitations: true,
  schema: synthesisSchema,
  system: [
    "You are the ConstructOS multi-document reasoner.",
    "Answer the question using ONLY the supplied drawing text, specification text and RFI records.",
    "Where two documents disagree — a drawing note against a spec clause, an RFI answer against either — record it in conflicts with both citations. Finding the conflict is more valuable than smoothing it over.",
    'If the documents do not answer the question, set "answer" to null and say nothing more.',
    outputContract(
      '{"answer":string|null,"conflicts":[{"description":string,"citations":[{"type":string,"id":string}]}],"citations":[{"type":string,"id":string}],"confidence":number}',
    ),
  ].join("\n"),

  async gather(ctx: AgentContext): Promise<GatherResult> {
    if (!ctx.projectId) return { context: "", inputRefs: [], skip: "Needs a project" };
    const question = paramString(ctx, "question");
    if (!question || question.length < 3) {
      return { context: "", inputRefs: [], skip: "Supply a question of at least 3 characters" };
    }
    const pattern = `%${escapeLike(question)}%`;

    const drawings = await ctx.db
      .select({
        sheetId: drawingSheets.id,
        number: drawingSheets.number,
        title: drawingSheets.title,
        text: drawingRevisions.extractedText,
      })
      .from(drawingRevisions)
      .innerJoin(drawingSheets, eq(drawingSheets.id, drawingRevisions.sheetId))
      .where(
        and(
          eq(drawingSheets.companyId, ctx.companyId),
          eq(drawingSheets.projectId, ctx.projectId),
          eq(drawingRevisions.isSuperseded, 0),
          ilike(drawingRevisions.extractedText, pattern),
        ),
      )
      .limit(8);

    const specs = await ctx.db
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
          or(
            ilike(specSections.title, pattern),
            ilike(specSectionRevisions.extractedText, pattern),
          ),
        ),
      )
      .limit(8);

    const rfiRows = await ctx.db
      .select({
        id: rfis.id,
        number: rfis.number,
        subject: rfis.subject,
        question: rfis.question,
        officialResponse: rfis.officialResponse,
      })
      .from(rfis)
      .where(
        and(
          eq(rfis.companyId, ctx.companyId),
          eq(rfis.projectId, ctx.projectId),
          or(
            ilike(rfis.subject, pattern),
            ilike(rfis.question, pattern),
            ilike(rfis.officialResponse, pattern),
          ),
        ),
      )
      .limit(8);

    const rows: EvidenceRow[] = [];
    for (const d of drawings) {
      rows.push({
        type: "drawing_sheet",
        id: d.sheetId,
        label: `Drawing ${d.number} — ${d.title}`,
        detail: clip(d.text, 2500),
      });
    }
    for (const s of specs) {
      rows.push({
        type: "spec_section",
        id: s.sectionId,
        label: `Spec section ${s.code} — ${s.title}`,
        detail: clip(s.text, 2500),
      });
    }
    for (const r of rfiRows) {
      rows.push({
        type: "rfi",
        id: r.id,
        label: `RFI #${r.number} — ${clip(r.subject, 120)}`,
        detail: `Q: ${clip(r.question, 800)}\nA: ${clip(r.officialResponse, 800)}`,
      });
    }
    if (rows.length === 0) {
      return {
        context: "",
        inputRefs: [],
        skip: `No drawing, specification or RFI text matches "${question}"`,
      };
    }
    return {
      context: `QUESTION: ${question}\n\n${renderEvidence(rows)}`,
      inputRefs: refsOf(rows),
      contradictions: rows.length > 1 ? rows.length : 0,
      facts: { question },
    };
  },

  propose(output, ctx, gathered): ProposalDraft[] {
    if (output.answer === null && output.conflicts.length === 0) return [];
    const question = typeof gathered.facts?.["question"] === "string"
      ? (gathered.facts["question"] as string)
      : "";
    return [
      {
        targetType: "document_synthesis" as const,
        targetId: null,
        summary: `Synthesis for "${clip(question, 100)}" — ${output.conflicts.length} conflict(s)`,
        proposal: { ...output, question, projectId: ctx.projectId },
        confidence: output.confidence,
      },
    ];
  },

  summarise(output) {
    if (output.answer === null) return "The documents supplied do not answer the question";
    return `Answered with ${output.conflicts.length} document conflict(s) named`;
  },
});

export const assuranceAgents = [
  evidenceSufficiencyScorer,
  counterfactualAnalyst,
  anomalyExplainer,
  integrityMonitor,
  multiDocumentReasoner,
];
