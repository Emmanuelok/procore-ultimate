/**
 * The agent registry — the platform's inventory of what an AI agent on this
 * system is allowed to be (Vol I #775 model inventory, Vol II X #1027 model
 * validation, plan §3.2 the /agents contract).
 *
 * Two populations live here:
 *   · FLEET agents (this wave) — declarative definitions the generic runner
 *     executes: gather real rows, call the model once, parse, propose.
 *   · LEGACY agents — the seven that predate the fleet and are served by
 *     their own routes (document search, RFI evaluation, submittal review,
 *     daily-log draft, sheet naming, photo intelligence, assistant). They
 *     appear in the inventory with `runnable: false` and the route that runs
 *     them, because an inventory that omits half the fleet is not one.
 *
 * Importing this module registers each kind's default policy, so a tenant
 * that has never opened the policy page still has a ceiling in force.
 */
import { AI_AGENT_KINDS, type AgentCategory } from "@constructos/shared";
import { promptVersion } from "./service.js";
import { registerPolicyDefaults, type PolicyDefaults } from "./policy.js";
import { assuranceAgents } from "./agents/assurance.js";
import { contractAgents } from "./agents/contract.js";
import { deliveryAgents } from "./agents/delivery.js";
import type { AnyAgentDefinition } from "./agents/types.js";

/* ------------------------------------------------------------------ */
/* Fleet                                                               */
/* ------------------------------------------------------------------ */

const fleet: AnyAgentDefinition[] = [...contractAgents, ...assuranceAgents, ...deliveryAgents];

export const AGENT_DEFINITIONS: ReadonlyMap<string, AnyAgentDefinition> = new Map(
  fleet.map((d) => [d.kind, d]),
);

for (const def of fleet) {
  const defaults: Partial<PolicyDefaults> = {
    ...(def.defaults ?? {}),
    // A consequential agent is propose-only unless a tenant deliberately
    // changes it; nothing here ships auto-applying.
    authorisation: def.defaults?.authorisation ?? "propose_only",
    allowedTargetTypes: def.defaults?.allowedTargetTypes ?? [...def.targetTypes],
  };
  registerPolicyDefaults(def.kind, defaults);
}

export function getAgentDefinition(kind: string): AnyAgentDefinition | null {
  return AGENT_DEFINITIONS.get(kind) ?? null;
}

/* ------------------------------------------------------------------ */
/* Legacy agents (own routes)                                          */
/* ------------------------------------------------------------------ */

export interface LegacyAgentEntry {
  kind: string;
  name: string;
  description: string;
  category: AgentCategory;
  scope: "project" | "company" | "both";
  inputs: string[];
  outputs: string[];
  dataCategories: string[];
  targetTypes: string[];
  consequential: boolean;
  route: string;
}

export const LEGACY_AGENTS: LegacyAgentEntry[] = [
  {
    kind: "document_search",
    name: "Document search",
    description:
      "Answers a question from the project's drawings, files, RFIs and submittals, citing the snippet each statement came from.",
    category: "assistant",
    scope: "project",
    inputs: ["drawing OCR text", "files", "RFIs", "submittals"],
    outputs: ["cited answer"],
    dataCategories: ["drawing_text", "correspondence", "project_metadata"],
    targetTypes: [],
    consequential: false,
    route: "POST /projects/:projectId/ai/search",
  },
  {
    kind: "rfi_evaluation",
    name: "RFI evaluation",
    description:
      "Drafts a suggested official response to an RFI from the pinned drawings and linked records, with a cost and schedule impact assessment.",
    category: "drafter",
    scope: "project",
    inputs: ["RFI", "pinned drawing revisions", "linked records"],
    outputs: ["suggested response"],
    dataCategories: ["correspondence", "drawing_text"],
    targetTypes: ["rfi_response"],
    consequential: true,
    route: "POST /projects/:projectId/ai/rfi-evaluate",
  },
  {
    kind: "submittal_review",
    name: "Submittal review",
    description:
      "Reviews a submittal against the specification clause text and its attached documents, and recommends a response code.",
    category: "reviewer",
    scope: "project",
    inputs: ["submittal", "attached documents", "specification section text"],
    outputs: ["recommendation", "findings"],
    dataCategories: ["specification_text", "field_records", "images"],
    targetTypes: ["submittal_review"],
    consequential: false,
    route: "POST /projects/:projectId/ai/submittal-review",
  },
  {
    kind: "daily_log_draft",
    name: "Daily log drafter",
    description:
      "Drafts a daily log for a date from that day's photos, punch activity and RFI movement, carrying forward the previous log's shape.",
    category: "drafter",
    scope: "project",
    inputs: ["photos", "punch items", "RFIs", "previous daily log"],
    outputs: ["daily log draft"],
    dataCategories: ["field_records", "images"],
    targetTypes: ["daily_log"],
    consequential: true,
    route: "POST /projects/:projectId/ai/daily-log-draft",
  },
  {
    kind: "sheet_naming",
    name: "Sheet naming",
    description:
      "Reads a drawing revision's title block OCR and proposes the sheet number, title and discipline.",
    category: "assistant",
    scope: "project",
    inputs: ["drawing revision OCR text"],
    outputs: ["sheet number", "title", "discipline"],
    dataCategories: ["drawing_text"],
    targetTypes: ["drawing_sheet"],
    consequential: true,
    route: "POST /projects/:projectId/ai/sheet-name",
  },
  {
    kind: "photo_intelligence",
    name: "Photo intelligence",
    description:
      "Tags a jobsite photo, summarises visible progress and raises a signal for a visible safety issue.",
    category: "assistant",
    scope: "project",
    inputs: ["photo image"],
    outputs: ["tags", "progress summary", "safety signals"],
    dataCategories: ["images", "field_records"],
    targetTypes: [],
    consequential: true,
    route: "POST /projects/:projectId/ai/photo-intel",
  },
  {
    kind: "assistant",
    name: "Platform assistant",
    description:
      "Answers questions about the platform and this project's overall state from record counts; it holds no live record access and says so.",
    category: "assistant",
    scope: "both",
    inputs: ["project metadata", "record counts"],
    outputs: ["answer"],
    dataCategories: ["project_metadata"],
    targetTypes: [],
    consequential: false,
    route: "POST /projects/:projectId/ai/assist",
  },
];

for (const legacy of LEGACY_AGENTS) {
  registerPolicyDefaults(legacy.kind, {
    authorisation: "propose_only",
    allowedTargetTypes: legacy.targetTypes,
  });
}

/* ------------------------------------------------------------------ */
/* Inventory                                                           */
/* ------------------------------------------------------------------ */

export interface AgentInventoryEntry {
  kind: string;
  name: string;
  description: string;
  category: AgentCategory;
  scope: "project" | "company" | "both";
  inputs: string[];
  outputs: string[];
  dataCategories: string[];
  targetTypes: string[];
  consequential: boolean;
  schedulable: boolean;
  runnable: boolean;
  requireCitations: boolean;
  route: string;
  promptVersion: string | null;
}

/** Every agent the platform has, fleet and legacy, in one stable order. */
export const AGENT_INVENTORY: AgentInventoryEntry[] = [
  ...fleet.map((d) => ({
    kind: d.kind,
    name: d.name,
    description: d.description,
    category: d.category,
    scope: d.scope,
    inputs: d.inputs,
    outputs: d.outputs,
    dataCategories: [...d.dataCategories],
    targetTypes: [...d.targetTypes],
    consequential: d.consequential,
    schedulable: d.schedulable,
    runnable: true,
    requireCitations: d.requireCitations,
    route: "POST /agents/:kind/run",
    promptVersion: promptVersion(d.system),
  })),
  ...LEGACY_AGENTS.filter((l) => !AGENT_DEFINITIONS.has(l.kind)).map((l) => ({
    kind: l.kind,
    name: l.name,
    description: l.description,
    category: l.category,
    scope: l.scope,
    inputs: l.inputs,
    outputs: l.outputs,
    dataCategories: l.dataCategories,
    targetTypes: l.targetTypes,
    consequential: l.consequential,
    schedulable: false,
    runnable: false,
    requireCitations: false,
    route: l.route,
    promptVersion: null,
  })),
];

/** Every agent kind the platform recognises — fleet, legacy and frozen. */
export const KNOWN_AGENT_KINDS: string[] = [
  ...new Set([...AGENT_INVENTORY.map((a) => a.kind), ...AI_AGENT_KINDS]),
];

export function isKnownAgentKind(kind: string): boolean {
  return KNOWN_AGENT_KINDS.includes(kind);
}

/** Which kinds a schedule may be created for. */
export const SCHEDULABLE_AGENT_KINDS: string[] = AGENT_INVENTORY.filter((a) => a.schedulable).map(
  (a) => a.kind,
);
