/**
 * SAFETY — INVESTIGATION ASSISTANT (Vol I §6.4; Vol II X #1017–1019).
 *
 * What this is: a reader. It assembles the incident, the reportability
 * determination, the witness statements, the observations raised on the same
 * location or against the same vendor in the ninety days before it, the
 * inspections of that work, the briefings the crew received and the prior
 * incidents sharing its mechanism — and asks the model to say what the pattern
 * is, citing the record id behind every claim.
 *
 * What it is NOT: an investigator. Nothing it returns is written to the
 * incident. Every suggestion is a proposal a human accepts or discards, and
 * acceptance is a separate, ledgered act carrying the agent run id. That is
 * not timidity: an investigation's conclusions are read by a regulator, an
 * insurer and possibly a court, and a root cause nobody can attribute to a
 * person is a root cause that will not survive being tested.
 *
 * THE CITATION RULE IS ENFORCED HERE, NOT REQUESTED. Every suggestion names
 * source record ids; any id that was not in the prompt is DROPPED before the
 * response leaves this module, and the count of dropped citations is returned.
 * A fabricated record id in an investigation file is worse than no citation.
 *
 * THE HIERARCHY RULE. Draft corrective actions are tagged with the level of
 * the hierarchy of control they sit at, and a proposal set consisting only of
 * administrative and PPE controls is called out as such. "Re-brief the
 * operatives" is the answer that produces the same accident again, and an
 * assistant that offers it without saying so is not helping.
 *
 * Pure: prompt in, prompt out; response in, reconciled response out. The route
 * layer owns the model call (runAgent) and the ledger.
 */

import { z } from "zod";
import type { HierarchyOfControl } from "@constructos/shared";
import type { ReportabilityDetermination } from "./reportability.js";

/* ================================================================== */
/* The context handed to the model                                     */
/* ================================================================== */

export interface AssistRecordRef {
  /** the ledger objectType, so a citation resolves to a real object */
  type: string;
  id: string;
  reference: string;
  label: string;
  /** the line the model is allowed to reason from */
  summary: string;
  occurredAt: string | null;
}

export interface AssistContext {
  incident: {
    id: string;
    reference: string;
    incidentType: string;
    severity: string;
    title: string;
    description: string;
    occurredAt: string;
    locationText: string | null;
    mechanism: string | null;
    injuryNature: string | null;
    bodyPart: string | null;
    activityAtTime: string | null;
    immediateCause: string | null;
    hoursIntoShift: number | null;
    shift: string | null;
    vendorName: string | null;
    injuredPersonType: string | null;
    daysSinceInduction: number | null;
    yearsExperience: number | null;
    witnesses: Array<{ name: string; organisation: string | null; statement: string | null }>;
  };
  determination: ReportabilityDetermination | null;
  priorObservations: AssistRecordRef[];
  priorIncidents: AssistRecordRef[];
  inspections: AssistRecordRef[];
  briefings: AssistRecordRef[];
  openActions: AssistRecordRef[];
  programmeRecords: AssistRecordRef[];
}

export const ASSIST_SYSTEM = [
  "You are assisting a construction incident investigation. You are not conducting it.",
  "",
  "You are given ONE incident and the records around it: observations raised on the same location or",
  "against the same subcontractor in the 90 days before, inspections of that work, briefings the crew",
  "received, prior incidents sharing the mechanism, the open corrective actions, the safety documents",
  "in force, and the statutory reportability determination.",
  "",
  "RULES YOU MUST FOLLOW:",
  "1. Every contributing factor, hypothesis and draft action MUST cite the ids of the records it is",
  "   drawn from, copied EXACTLY from the record headers given to you. Do not invent an id. A",
  "   suggestion you cannot source from the records provided must be marked sourceIds: [] and will be",
  "   shown to the reader as unsourced.",
  "2. Distinguish IMMEDIATE causes (what touched the person) from UNDERLYING and ORGANISATIONAL ones",
  "   (why the condition was there and why nobody removed it). An investigation that stops at the",
  "   immediate cause produces a corrective action that fixes one shift.",
  "3. Tag every draft corrective action with the hierarchy-of-control level it sits at:",
  "   elimination, substitution, engineering, isolation, administrative or ppe. Prefer the strongest",
  "   level the evidence supports. If everything you propose is administrative or ppe, say so",
  "   explicitly in weakControlNote.",
  "4. Where the reportability determination has open questions, phrase them as questions a site",
  "   manager can answer today about THIS event — not as legal tests.",
  "5. Say what you do not know. A hypothesis with no supporting record is still worth raising, but it",
  "   must be marked as such rather than dressed in a citation.",
  "",
  'Return ONLY a JSON object of the shape: {"contributingFactors": [{"factor": string, "category":',
  '"immediate"|"underlying"|"organisational", "note": string, "sourceIds": string[]}],',
  '"rootCauseHypotheses": [{"hypothesis": string, "rank": number, "reasoning": string, "sourceIds":',
  'string[], "testableBy": string}], "openQuestions": [{"question": string, "why": string}],',
  '"draftActions": [{"title": string, "description": string, "hierarchyOfControl": string,',
  '"targetDays": number, "sourceIds": string[]}], "weakControlNote": string|null, "summary": string,',
  '"confidence": number}',
  "confidence is 0-1 and reflects how much of your reasoning is grounded in the records provided.",
].join("\n");

const HIERARCHY: readonly HierarchyOfControl[] = [
  "elimination",
  "substitution",
  "engineering",
  "isolation",
  "administrative",
  "ppe",
];

export const assistOutputSchema = z.object({
  contributingFactors: z
    .array(
      z.object({
        factor: z.string().min(1).max(500),
        category: z.enum(["immediate", "underlying", "organisational"]),
        note: z.string().max(2000).nullable().optional(),
        sourceIds: z.array(z.string().max(64)).max(20).default([]),
      }),
    )
    .max(20)
    .default([]),
  rootCauseHypotheses: z
    .array(
      z.object({
        hypothesis: z.string().min(1).max(1000),
        rank: z.number().int().min(1).max(20).optional(),
        reasoning: z.string().max(4000).nullable().optional(),
        sourceIds: z.array(z.string().max(64)).max(20).default([]),
        testableBy: z.string().max(1000).nullable().optional(),
      }),
    )
    .max(10)
    .default([]),
  openQuestions: z
    .array(
      z.object({
        question: z.string().min(1).max(1000),
        why: z.string().max(2000).nullable().optional(),
      }),
    )
    .max(20)
    .default([]),
  draftActions: z
    .array(
      z.object({
        title: z.string().min(1).max(300),
        description: z.string().max(4000).nullable().optional(),
        hierarchyOfControl: z.string().max(40),
        targetDays: z.number().int().min(0).max(365).optional(),
        sourceIds: z.array(z.string().max(64)).max(20).default([]),
      }),
    )
    .max(15)
    .default([]),
  weakControlNote: z.string().max(2000).nullable().optional(),
  summary: z.string().max(4000).nullable().optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
});

export type AssistOutput = z.infer<typeof assistOutputSchema>;

/* ================================================================== */
/* Prompt assembly                                                     */
/* ================================================================== */

function renderRefs(title: string, refs: readonly AssistRecordRef[], emptyNote: string): string {
  if (refs.length === 0) return `${title}\n  (none — ${emptyNote})\n`;
  const lines = refs.map(
    (r) =>
      `  [${r.type} id=${r.id} ref=${r.reference}${r.occurredAt ? ` at=${r.occurredAt}` : ""}] ${r.label}\n` +
      `      ${r.summary}`,
  );
  return `${title}\n${lines.join("\n")}\n`;
}

export interface AssembledPrompt {
  system: string;
  user: string;
  /** every id the model is allowed to cite */
  allowedIds: Set<string>;
  inputRefs: Array<{ type: string; id: string }>;
  contextChars: number;
}

export function buildAssistPrompt(ctx: AssistContext): AssembledPrompt {
  const inc = ctx.incident;
  const facts = [
    `Reference: ${inc.reference}`,
    `Type: ${inc.incidentType}; severity: ${inc.severity}`,
    `Occurred: ${inc.occurredAt}${inc.shift ? ` (shift: ${inc.shift})` : ""}${
      inc.hoursIntoShift != null ? `, ${inc.hoursIntoShift}h into the shift` : ""
    }`,
    `Location: ${inc.locationText ?? "not recorded"}`,
    `Mechanism: ${inc.mechanism ?? "not coded"}; injury: ${inc.injuryNature ?? "not coded"}${
      inc.bodyPart ? ` to the ${inc.bodyPart}` : ""
    }`,
    `Activity at the time: ${inc.activityAtTime ?? "not recorded"}`,
    `Immediate cause as recorded: ${inc.immediateCause ?? "not recorded"}`,
    `Injured person: ${inc.injuredPersonType ?? "type not recorded"}${
      inc.vendorName ? `, employed by ${inc.vendorName}` : ""
    }${inc.daysSinceInduction != null ? `, ${inc.daysSinceInduction} days since induction` : ""}${
      inc.yearsExperience != null ? `, ${inc.yearsExperience} years' experience` : ""
    }`,
  ].join("\n");

  const witnesses =
    inc.witnesses.length === 0
      ? "  (no witness statement is recorded)"
      : inc.witnesses
          .map(
            (w, i) =>
              `  ${i + 1}. ${w.name}${w.organisation ? ` (${w.organisation})` : ""}: ${
                w.statement ?? "statement not transcribed"
              }`,
          )
          .join("\n");

  const determination = ctx.determination
    ? [
        `Reportable: ${ctx.determination.isReportable}`,
        `Regimes assessed: ${ctx.determination.assessedRegimes.join(", ") || "none"}`,
        `RIDDOR category: ${ctx.determination.riddorCategory}; OSHA case type: ${ctx.determination.oshaCaseType}`,
        ctx.determination.openQuestions.length > 0
          ? `Open statutory questions:\n${ctx.determination.openQuestions.map((q) => `    - ${q}`).join("\n")}`
          : "Open statutory questions: none",
      ].join("\n")
    : "  (reportability has not been assessed on this incident)";

  const allRefs = [
    ...ctx.priorObservations,
    ...ctx.priorIncidents,
    ...ctx.inspections,
    ...ctx.briefings,
    ...ctx.openActions,
    ...ctx.programmeRecords,
  ];

  const user = [
    "THE INCIDENT",
    facts,
    "",
    "Narrative as recorded:",
    inc.description,
    "",
    "WITNESS STATEMENTS",
    witnesses,
    "",
    "STATUTORY DETERMINATION",
    determination,
    "",
    renderRefs(
      "OBSERVATIONS ON THIS LOCATION OR THIS SUBCONTRACTOR IN THE PRIOR 90 DAYS",
      ctx.priorObservations,
      "nothing was reported here in the 90 days before this event, which is itself worth a comment",
    ),
    renderRefs(
      "PRIOR INCIDENTS SHARING THE MECHANISM OR THE LOCATION",
      ctx.priorIncidents,
      "no earlier incident on this project shares the mechanism",
    ),
    renderRefs(
      "INSPECTIONS OF THIS WORK",
      ctx.inspections,
      "this work was not inspected in the period before the event",
    ),
    renderRefs(
      "BRIEFINGS DELIVERED TO THIS CREW",
      ctx.briefings,
      "no briefing is recorded for this crew in the period",
    ),
    renderRefs(
      "CORRECTIVE ACTIONS ALREADY OPEN ON THIS PROJECT",
      ctx.openActions,
      "no corrective action was open",
    ),
    renderRefs(
      "SAFETY DOCUMENTS IN FORCE FOR THIS ACTIVITY",
      ctx.programmeRecords,
      "no RAMS, permit or method statement is on file for this activity",
    ),
  ].join("\n");

  const allowedIds = new Set<string>([inc.id, ...allRefs.map((r) => r.id)]);
  return {
    system: ASSIST_SYSTEM,
    user,
    allowedIds,
    inputRefs: [
      { type: "safety_incident", id: inc.id },
      ...allRefs.map((r) => ({ type: r.type, id: r.id })),
    ],
    contextChars: user.length,
  };
}

/* ================================================================== */
/* Reconciliation — what leaves this module                            */
/* ================================================================== */

export interface ReconciledSuggestion {
  /** ids that were in the prompt and survive */
  sourceIds: string[];
  /** ids the model produced that were never in the prompt */
  droppedIds: string[];
  /** true when nothing supports this suggestion */
  unsourced: boolean;
}

export interface ReconciledAssist {
  contributingFactors: Array<
    AssistOutput["contributingFactors"][number] & ReconciledSuggestion
  >;
  rootCauseHypotheses: Array<AssistOutput["rootCauseHypotheses"][number] & ReconciledSuggestion>;
  openQuestions: AssistOutput["openQuestions"];
  draftActions: Array<
    Omit<AssistOutput["draftActions"][number], "hierarchyOfControl"> &
      ReconciledSuggestion & {
        hierarchyOfControl: HierarchyOfControl | null;
        hierarchyReason: string | null;
      }
  >;
  weakControlNote: string | null;
  summary: string | null;
  confidence: number | null;
  /** total citations dropped as unresolvable */
  droppedCitations: number;
  /** every proposed control sits at the weak end */
  onlyWeakControls: boolean;
  notes: string[];
}

/**
 * Drop every citation the prompt did not contain, normalise the hierarchy
 * level, and judge the proposal set as a whole. A model that returns six
 * briefings gets told so here rather than in a review three months later.
 */
export function reconcileAssist(output: AssistOutput, allowedIds: ReadonlySet<string>): ReconciledAssist {
  let dropped = 0;
  const notes: string[] = [];

  const split = (ids: readonly string[]): ReconciledSuggestion => {
    const keep = ids.filter((id) => allowedIds.has(id));
    const drop = ids.filter((id) => !allowedIds.has(id));
    dropped += drop.length;
    return { sourceIds: keep, droppedIds: drop, unsourced: keep.length === 0 };
  };

  const contributingFactors = output.contributingFactors.map((f) => ({ ...f, ...split(f.sourceIds) }));
  const rootCauseHypotheses = output.rootCauseHypotheses
    .map((h) => ({ ...h, ...split(h.sourceIds) }))
    .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));

  const draftActions = output.draftActions.map((a) => {
    const level = HIERARCHY.find((h) => h === a.hierarchyOfControl.toLowerCase()) ?? null;
    const { hierarchyOfControl: _drop, ...rest } = a;
    return {
      ...rest,
      ...split(a.sourceIds),
      hierarchyOfControl: level,
      hierarchyReason:
        level === null
          ? `The model returned "${a.hierarchyOfControl}", which is not a level of the hierarchy of ` +
            `control. The action is kept and the level is left unset for a human to choose.`
          : null,
    };
  });

  const levelled = draftActions.filter((a) => a.hierarchyOfControl !== null);
  const onlyWeakControls =
    levelled.length > 0 &&
    levelled.every((a) => a.hierarchyOfControl === "administrative" || a.hierarchyOfControl === "ppe");
  if (onlyWeakControls) {
    notes.push(
      "Every corrective action proposed sits at the administrative or PPE end of the hierarchy of " +
        "control — a briefing, a procedure or an item of kit. Those are the controls that depend on " +
        "the person at the sharp end doing the right thing every time under production pressure, and " +
        "a register full of them is a register that will see this event again. Before accepting any " +
        "of them, ask what would have to change for the hazard to be designed out, guarded or " +
        "isolated instead.",
    );
  }
  if (dropped > 0) {
    notes.push(
      `${dropped} citation(s) referenced records that were not in the prompt and have been dropped. ` +
        `A fabricated record id in an investigation file is worse than no citation at all.`,
    );
  }
  const unsourcedCount =
    contributingFactors.filter((f) => f.unsourced).length +
    rootCauseHypotheses.filter((h) => h.unsourced).length;
  if (unsourcedCount > 0) {
    notes.push(
      `${unsourcedCount} suggestion(s) cite no record at all. They are shown because an unsourced ` +
        `hypothesis can still be the right one, but nothing in the platform supports them yet.`,
    );
  }

  return {
    contributingFactors,
    rootCauseHypotheses,
    openQuestions: output.openQuestions,
    draftActions,
    weakControlNote: output.weakControlNote ?? null,
    summary: output.summary ?? null,
    confidence: output.confidence ?? null,
    droppedCitations: dropped,
    onlyWeakControls,
    notes,
  };
}
