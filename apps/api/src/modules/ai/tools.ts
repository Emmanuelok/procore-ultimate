/**
 * Which TOOL owns a given piece of AI-adjacent data?
 *
 * Two maps, one rule: `ai:standard` is never a gate on another module's
 * records. `targetTool` gates a review-queue proposal by the tool that owns
 * the data its BODY quotes, and `refTool` gates reading a run back by the
 * tools that own the records it actually gathered.
 *
 * They live in their own file because reports.ts (the adversarial harness)
 * asserts against them and index.ts imports the harness — a cycle nobody
 * needs.
 */
import type { ToolKey } from "@constructos/shared";

/**
 * Which operational tool must the reviewer hold to READ or APPLY a proposal?
 *
 * Every target type maps to the tool that owns the data the proposal carries,
 * not just the ones that mutate a record on approval. An advisory proposal is
 * not harmless: a `cost_forecast` body quotes budget lines, a `bid_levelling`
 * body quotes competing bidders' rates, an `incident_classification` body
 * quotes an injured worker's account. Returning null for those (the old
 * behaviour) gated them at `ai` level, so an ai:standard / budget:none member
 * could read every budget figure out of the queue.
 */
export function targetTool(targetType: string): ToolKey | null {
  switch (targetType) {
    /* operational targets: approval moves the record */
    case "daily_log":
      return "daily_logs";
    case "rfi_response":
      return "rfis";
    case "drawing_sheet":
      return "drawings";
    case "submittal_review":
      return "submittals";
    case "signal_explanation":
      return "assurance";
    // agent_actions.targetType only: the photo-intelligence write.
    case "photo":
      return "photos";
    /* advisory targets: approval records acceptance, but the BODY is data */
    case "obligation_finding":
    case "notice_draft":
      return "contracts";
    case "claim_narrative":
    case "rebuttal":
      return "forensics";
    case "evidence_assessment":
    case "counterfactual":
    case "integrity_memo":
      return "assurance";
    case "risk_finding":
      return "risk";
    case "document_synthesis":
      return "drawings";
    case "cost_forecast":
    case "change_impact":
      return "budget";
    case "schedule_risk":
      return "schedule";
    case "meeting_minutes":
      return "meetings";
    case "incident_classification":
      return "safety";
    case "spec_compliance":
      return "specifications";
    case "bid_levelling":
      return "bidding";
    default:
      return null;
  }
}

/**
 * Which tool owns a record type an agent put in its prompt?
 *
 * `ai_runs.inputRefs` records exactly what was supplied, so this is the
 * PRECISE gate on reading a run back: the prompt of a cost forecaster holds
 * budget lines, of an incident classifier a worker's account, of a grounded
 * search a drawing's OCR. It is used in preference to the agent's declared
 * `requiredTools` because a definition's list is the union over every run
 * while the refs are what THIS run actually read — the difference is the
 * searcher who is allowed to read back their own partially-sourced answer.
 * An unmapped type falls back to `ai`, never to "no gate".
 */
export function refTool(refType: string): ToolKey | null {
  switch (refType) {
    case "project":
    case "company":
      return null;
    case "file":
      return "documents";
    case "drawing_sheet":
    case "drawing_revision":
      return "drawings";
    case "spec_section":
      return "specifications";
    case "rfi":
      return "rfis";
    case "submittal":
      return "submittals";
    case "daily_log":
      return "daily_logs";
    case "punch":
      return "punch";
    case "photo":
      return "photos";
    case "meeting":
    case "meeting_agenda_item":
    case "meeting_action_item":
      return "meetings";
    case "contract":
    case "contract_event":
    case "obligation":
      return "contracts";
    case "forensic_claim":
    case "delay_event":
      return "forensics";
    case "assertion":
    case "evidence":
    case "reconciliation":
    case "signal":
    case "entity_relationship":
      return "assurance";
    case "risk":
      return "risk";
    case "budget_line_item":
    case "change_event":
      return "budget";
    case "commitment":
      return "commitments";
    case "schedule_task":
      return "schedule";
    case "safety_incident":
      return "safety";
    case "ncr":
      return "quality";
    case "bid_package":
    case "bid_submission":
      return "bidding";
    case "ai_run":
      return "ai";
    default:
      return "ai";
  }
}

/** The distinct tools a run's supplied records belong to. */
export function toolsForRefs(refs: unknown[]): ToolKey[] {
  const out = new Set<ToolKey>();
  for (const ref of refs) {
    const type = (ref as { type?: unknown } | null)?.type;
    if (typeof type !== "string") continue;
    const tool = refTool(type);
    if (tool) out.add(tool);
  }
  return [...out];
}
