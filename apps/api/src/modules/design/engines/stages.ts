/**
 * DESIGN STAGE LIBRARY (spec #888, #889) — pure, code-resident, no I/O.
 *
 * A project run under the RIBA Plan of Work, one run under the AIA phases and
 * one run under ISO 19650 information stages are describing the same journey
 * in three vocabularies. Everything downstream of this file — packages,
 * gates, deliverables, readiness — speaks ONE canonical key (RIBA 2020
 * stage_0…stage_7) and this library translates.
 *
 * What it deliberately does not do: hold project dates (design_stage_gates
 * does) or decide whether a gate may be passed (readiness.ts does).
 */
import {
  DESIGN_STAGE_KEYS,
  type DesignStageFramework,
  type DesignStageKey,
} from "@constructos/shared";

export interface StageDefinition {
  key: DesignStageKey;
  /** 0..7 — the order stages are passed in */
  order: number;
  riba: string;
  aia: string;
  iso19650: string;
  /** what the stage is for, in one line */
  purpose: string;
  /** the usual outcome that lets the gate close */
  gateOutcome: string;
  /** stages at or after this one are normally frozen before construction */
  isConstructionStage: boolean;
}

export const DESIGN_STAGES: readonly StageDefinition[] = [
  {
    key: "stage_0",
    order: 0,
    riba: "Stage 0 — Strategic Definition",
    aia: "Pre-Design",
    iso19650: "Assessment and need",
    purpose: "Establish the business case and the best means of achieving the client's outcomes.",
    gateOutcome: "Business case and strategic brief approved.",
    isConstructionStage: false,
  },
  {
    key: "stage_1",
    order: 1,
    riba: "Stage 1 — Preparation and Briefing",
    aia: "Programming",
    iso19650: "Invitation to tender",
    purpose: "Develop the project brief, feasibility studies and the site information.",
    gateOutcome: "Project brief approved and feasibility confirmed.",
    isConstructionStage: false,
  },
  {
    key: "stage_2",
    order: 2,
    riba: "Stage 2 — Concept Design",
    aia: "Schematic Design",
    iso19650: "Tender response",
    purpose: "Produce the architectural concept aligned to the brief and the cost plan.",
    gateOutcome: "Concept design signed off against the brief and budget.",
    isConstructionStage: false,
  },
  {
    key: "stage_3",
    order: 3,
    riba: "Stage 3 — Spatial Coordination",
    aia: "Design Development",
    iso19650: "Appointment",
    purpose: "Spatially coordinate the design across disciplines and test it against the brief.",
    gateOutcome: "Coordinated design frozen; planning position resolved.",
    isConstructionStage: false,
  },
  {
    key: "stage_4",
    order: 4,
    riba: "Stage 4 — Technical Design",
    aia: "Construction Documents",
    iso19650: "Mobilisation",
    purpose: "Produce all the information needed to manufacture and construct.",
    gateOutcome: "Technical design complete and released for construction.",
    isConstructionStage: true,
  },
  {
    key: "stage_5",
    order: 5,
    riba: "Stage 5 — Manufacturing and Construction",
    aia: "Construction Administration",
    iso19650: "Production",
    purpose: "Build what was designed; resolve site queries and design changes.",
    gateOutcome: "Construction complete and inspected.",
    isConstructionStage: true,
  },
  {
    key: "stage_6",
    order: 6,
    riba: "Stage 6 — Handover",
    aia: "Project Closeout",
    iso19650: "Handover",
    purpose: "Hand over the building and conclude the building contract.",
    gateOutcome: "Building handed over with the asset information model accepted.",
    isConstructionStage: true,
  },
  {
    key: "stage_7",
    order: 7,
    riba: "Stage 7 — Use",
    aia: "Facility Management",
    iso19650: "Operation",
    purpose: "Operate the asset and feed performance back into the next project.",
    gateOutcome: "Post-occupancy evaluation complete.",
    isConstructionStage: false,
  },
];

const BY_KEY = new Map<string, StageDefinition>(DESIGN_STAGES.map((s) => [s.key, s]));

export function stageDefinition(key: string | null | undefined): StageDefinition | null {
  if (!key) return null;
  return BY_KEY.get(key) ?? null;
}

export function stageOrder(key: string | null | undefined): number | null {
  return stageDefinition(key)?.order ?? null;
}

export function isStageKey(value: unknown): value is DesignStageKey {
  return typeof value === "string" && (DESIGN_STAGE_KEYS as readonly string[]).includes(value);
}

/** The label to show for a stage in the framework the project speaks. */
export function stageLabel(key: string | null | undefined, framework: DesignStageFramework): string | null {
  const def = stageDefinition(key);
  if (!def) return null;
  switch (framework) {
    case "aia":
      return def.aia;
    case "iso_19650":
      return def.iso19650;
    default:
      return def.riba;
  }
}

const NORMALISE = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Resolve any of the three vocabularies (plus loose forms people actually
 * type: "RIBA 3", "Stage 4", "DD", "CD", "Schematic") onto the canonical key.
 * Returns null rather than guessing when nothing matches.
 */
export function resolveStageKey(input: string | null | undefined): DesignStageKey | null {
  if (!input) return null;
  const raw = NORMALISE(input);
  if (raw === "") return null;

  // canonical / numeric forms
  const numeric = raw.match(/^(?:riba\s*)?(?:stage\s*)?([0-7])$/);
  if (numeric?.[1]) return `stage_${numeric[1]}` as DesignStageKey;

  const aliases: Record<string, DesignStageKey> = {
    "pre design": "stage_0",
    predesign: "stage_0",
    "strategic definition": "stage_0",
    programming: "stage_1",
    "preparation and briefing": "stage_1",
    "preparation and brief": "stage_1",
    feasibility: "stage_1",
    "schematic design": "stage_2",
    schematic: "stage_2",
    sd: "stage_2",
    "concept design": "stage_2",
    concept: "stage_2",
    "design development": "stage_3",
    dd: "stage_3",
    "spatial coordination": "stage_3",
    "developed design": "stage_3",
    "construction documents": "stage_4",
    cd: "stage_4",
    "technical design": "stage_4",
    "detailed design": "stage_4",
    "ifc": "stage_4",
    "construction administration": "stage_5",
    ca: "stage_5",
    construction: "stage_5",
    "manufacturing and construction": "stage_5",
    "project closeout": "stage_6",
    closeout: "stage_6",
    handover: "stage_6",
    "facility management": "stage_7",
    "in use": "stage_7",
    use: "stage_7",
    operation: "stage_7",
  };
  const alias = aliases[raw];
  if (alias) return alias;

  for (const def of DESIGN_STAGES) {
    if (NORMALISE(def.riba) === raw || NORMALISE(def.aia) === raw || NORMALISE(def.iso19650) === raw) {
      return def.key;
    }
    // "stage 3 spatial coordination" style input
    if (raw.includes(NORMALISE(def.aia)) && NORMALISE(def.aia).length > 3) return def.key;
  }
  return null;
}

/** Every stage rendered in one framework, ready for a picker. */
export function stageLibrary(framework: DesignStageFramework) {
  return DESIGN_STAGES.map((def) => ({
    key: def.key,
    order: def.order,
    label: stageLabel(def.key, framework) ?? def.riba,
    riba: def.riba,
    aia: def.aia,
    iso19650: def.iso19650,
    purpose: def.purpose,
    gateOutcome: def.gateOutcome,
    isConstructionStage: def.isConstructionStage,
  }));
}

/**
 * Whether a gate may close: every criterion met. Returns the unmet ones so
 * the refusal quotes them rather than saying "not allowed".
 */
export function gateBlockers(
  criteria: ReadonlyArray<{ key: string; label: string; met: boolean }>,
): string[] {
  return criteria.filter((c) => !c.met).map((c) => c.label || c.key);
}

/**
 * A stage plan is out of order when an earlier stage is still open while a
 * later one has been signed off. Reported, never auto-corrected.
 */
export function outOfOrderStages(
  gates: ReadonlyArray<{ stageKey: string; status: string }>,
): string[] {
  const signedOff = gates
    .filter((g) => g.status === "signed_off")
    .map((g) => stageOrder(g.stageKey))
    .filter((o): o is number => o !== null);
  if (signedOff.length === 0) return [];
  const highestSignedOff = Math.max(...signedOff);
  return gates
    .filter((g) => {
      const order = stageOrder(g.stageKey);
      return order !== null && order < highestSignedOff && g.status !== "signed_off";
    })
    .map((g) => g.stageKey);
}
