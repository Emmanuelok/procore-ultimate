/**
 * Method-of-measurement rule engines (spec Vol II Domain B #117-134).
 *
 * WHAT THIS IS
 * A code-resident, deterministic validator for a Bill of Quantities against
 * the measurement standard it claims to follow: NRM2, CESMM4, SMM7 or POMI.
 * Each standard is described by a small profile (permitted units, item-code
 * grammar, quantity presentation rules, description conventions) plus a set
 * of rules that run over every item and over the bill as a whole.
 *
 * WHY IT IS RULES-IN-CODE
 * A BQ that says "NRM2" and is not measured to NRM2 is a commercial risk that
 * only surfaces at remeasurement or in a dispute. The rules here are the ones
 * that can be checked from the record itself — unit, code grammar, quantity
 * presentation, structure, item-type conventions. They are cited by rule id
 * and clause so a finding can be argued with, not just displayed.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * It does not attempt to judge whether the *right* work was measured, whether
 * a description contains every classification-table dimension of the standard,
 * or whether quantities are arithmetically correct against the drawings —
 * those need the drawings, not the bill. `custom` bills get structural rules
 * only, and say so.
 */
import type { BoqMethod } from "@constructos/shared";
import type { MomRuleScope, MomSeverity } from "@constructos/shared";

export interface MomItemInput {
  id: string;
  parentId: string | null;
  level: string;
  code: string;
  description: string;
  unit: string | null;
  quantity: number | null;
  rate: number | null;
  amount: number | null;
  itemType: string;
}

export interface MomFinding {
  itemId: string | null;
  code: string | null;
  ruleId: string;
  severity: MomSeverity;
  scope: MomRuleScope;
  message: string;
  /** the standard's rule this comes from, for citation in the UI */
  reference: string;
}

export interface MomReport {
  method: BoqMethod;
  standardName: string;
  supported: boolean;
  itemsChecked: number;
  findings: MomFinding[];
  counts: { error: number; warning: number; info: number };
  /** 0..100 — 100 with no findings; errors cost 4×, warnings 1× per item */
  complianceScore: number | null;
  notes: string[];
}

interface StandardProfile {
  name: string;
  /** lower-cased units the standard recognises */
  units: string[];
  /** units that mean "not measured by quantity" */
  lumpUnits: string[];
  /** item-code grammar; undefined = no code convention to check */
  codePattern?: RegExp;
  codeHint?: string;
  /**
   * Quantities of 1 or more are billed to the nearest whole unit; below 1 to
   * two decimals. NRM2 3.3.2 / CESMM4 5.18 / SMM7 General Rules 3.
   */
  wholeUnitRounding: boolean;
  /** minimum characters a billed description needs to be a description */
  minDescription: number;
  reference: string;
}

const SHARED_UNITS = ["m", "m2", "m3", "nr", "kg", "t", "item", "sum", "%", "hr", "wk", "day"];

const PROFILES: Record<string, StandardProfile> = {
  nrm2: {
    name: "NRM2 — RICS New Rules of Measurement, Detailed measurement for building works",
    units: [...SHARED_UNITS, "mm", "l", "m/wk", "nr/wk"],
    lumpUnits: ["item", "sum", "%"],
    // Work section / sub-section / item — "2", "2.3", "2.3.1.4"
    codePattern: /^\d{1,2}(\.\d{1,3}){0,4}$/,
    codeHint: "NRM2 work-section numbering, e.g. 5.2.1",
    wholeUnitRounding: true,
    minDescription: 12,
    reference: "NRM2 Part 3 (Rules of measurement), 3.3",
  },
  cesmm4: {
    name: "CESMM4 — Civil Engineering Standard Method of Measurement, 4th edition",
    units: [...SHARED_UNITS, "h", "ha"],
    lumpUnits: ["item", "sum"],
    // Class letter, then up to three division digits, optional suffix: E, E3,
    // E325, E325.1 — a bare class letter heads the class.
    codePattern: /^[A-Z]\d{0,3}(\.\d{1,2})?$/,
    codeHint: "CESMM4 item code: class letter then division digits, e.g. E325",
    wholeUnitRounding: true,
    minDescription: 10,
    reference: "CESMM4 Section 3 (Coding and numbering), Section 5 (Measurement)",
  },
  smm7: {
    name: "SMM7 — Standard Method of Measurement of Building Works, 7th edition",
    units: [...SHARED_UNITS],
    lumpUnits: ["item", "sum"],
    // Work section letter+digits, optional sub-divisions: F, F10, F10.1.2
    codePattern: /^[A-Z]\d{0,2}(\.\d{1,2}){0,3}$/,
    codeHint: "SMM7 work-section code, e.g. F10 or F10.1",
    wholeUnitRounding: true,
    minDescription: 10,
    reference: "SMM7 General Rules 3 (quantities) and the work-section tables",
  },
  pomi: {
    name: "POMI — Principles of Measurement (International)",
    units: [...SHARED_UNITS],
    lumpUnits: ["item", "sum"],
    codePattern: /^\d{1,2}(\.\d{1,3}){0,3}$/,
    codeHint: "POMI section numbering, e.g. 3.2.1",
    wholeUnitRounding: false,
    minDescription: 10,
    reference: "POMI General Principles GP2-GP4",
  },
};

const PROVISIONAL_WORDS = ["provisional", "provisional sum", "prov sum"];
const VAGUE_WORDS = ["tbc", "tba", "to be confirmed", "to be advised", "???"];

function normUnit(unit: string | null): string {
  return (unit ?? "").trim().toLowerCase().replace(/\s+/g, "");
}

/** Quantity presentation: ≥1 to the nearest whole unit, <1 to two decimals. */
function quantityPresentationOk(q: number): boolean {
  if (Math.abs(q) >= 1) return Number.isInteger(Math.round(q * 1000) / 1000);
  return Math.abs(q * 100 - Math.round(q * 100)) < 1e-9;
}

/**
 * Validate a BoQ's leaf items and structure against a measurement standard.
 * Pure: same items in, same findings out, in a stable order.
 */
export function validateBoq(method: BoqMethod, items: MomItemInput[]): MomReport {
  const profile = PROFILES[method];
  const findings: MomFinding[] = [];
  const notes: string[] = [];
  const leaves = items.filter((i) => i.level === "item");

  const push = (
    item: MomItemInput | null,
    ruleId: string,
    severity: MomSeverity,
    scope: MomRuleScope,
    message: string,
    reference: string,
  ) => {
    findings.push({
      itemId: item?.id ?? null,
      code: item?.code ?? null,
      ruleId,
      severity,
      scope,
      message,
      reference,
    });
  };

  /* ---------------- structural rules (every standard) ---------------- */

  const byId = new Map(items.map((i) => [i.id, i]));
  const childCount = new Map<string, number>();
  for (const i of items) {
    if (i.parentId) childCount.set(i.parentId, (childCount.get(i.parentId) ?? 0) + 1);
  }
  for (const bill of items.filter((i) => i.level === "bill")) {
    if ((childCount.get(bill.id) ?? 0) === 0) {
      push(
        bill,
        "structure.empty_bill",
        "warning",
        "structure",
        `Bill "${bill.code}" contains no sections or items.`,
        "General: a bill with no measured work carries no value",
      );
    }
  }
  const seenCodes = new Map<string, string>();
  for (const item of items) {
    const key = item.code.trim().toLowerCase();
    const prior = seenCodes.get(key);
    if (prior) {
      push(
        item,
        "structure.duplicate_code",
        "error",
        "code",
        `Item code "${item.code}" is used more than once in this bill.`,
        "General: an item reference must identify one item",
      );
    } else {
      seenCodes.set(key, item.id);
    }
  }
  for (const leaf of leaves) {
    const parent = leaf.parentId ? byId.get(leaf.parentId) : undefined;
    if (parent && parent.level === "item") {
      push(
        leaf,
        "structure.item_under_item",
        "error",
        "structure",
        `Item "${leaf.code}" sits under another item; measured items belong under a section or bill.`,
        "General: bill > section > item",
      );
    }
  }

  if (!profile) {
    notes.push(
      method === "custom"
        ? "Custom bills carry no measurement-standard rules; only structural checks ran."
        : `No rule profile for method "${method}"; only structural checks ran.`,
    );
    const counts = tally(findings);
    return {
      method,
      standardName: method === "custom" ? "Custom (no standard)" : String(method),
      supported: false,
      itemsChecked: leaves.length,
      findings: sortFindings(findings),
      counts,
      complianceScore: null,
      notes,
    };
  }

  /* ------------------------ per-item rules --------------------------- */

  for (const item of items) {
    // Code grammar applies at every level: the numbering is the standard's.
    if (profile.codePattern && !profile.codePattern.test(item.code.trim())) {
      push(
        item,
        "code.grammar",
        "warning",
        "code",
        `Code "${item.code}" does not match ${profile.codeHint}.`,
        profile.reference,
      );
    }
    if (item.level !== "item") continue;

    const unit = normUnit(item.unit);
    const desc = item.description.trim();
    const lower = desc.toLowerCase();
    const isLump = profile.lumpUnits.includes(unit);
    const isProvisional = item.itemType.startsWith("provisional");

    if (!unit) {
      push(
        item,
        "unit.missing",
        "error",
        "unit",
        `Item "${item.code}" is measured without a unit.`,
        profile.reference,
      );
    } else if (!profile.units.includes(unit)) {
      push(
        item,
        "unit.not_recognised",
        "error",
        "unit",
        `Unit "${item.unit}" is not a ${profile.name.split(" —")[0]} unit (expected one of ${profile.units.join(", ")}).`,
        profile.reference,
      );
    }

    if (desc.length < profile.minDescription) {
      push(
        item,
        "description.too_short",
        "warning",
        "description",
        `Description for "${item.code}" is ${desc.length} characters; a billed description must identify the work.`,
        profile.reference,
      );
    }
    for (const vague of VAGUE_WORDS) {
      if (lower.includes(vague)) {
        push(
          item,
          "description.vague",
          "warning",
          "description",
          `Description for "${item.code}" contains "${vague}" — an unresolved description cannot be priced firmly.`,
          profile.reference,
        );
        break;
      }
    }

    if (item.quantity == null) {
      if (!isLump) {
        push(
          item,
          "quantity.missing",
          "error",
          "quantity",
          `Item "${item.code}" is measured in ${item.unit ?? "(no unit)"} but carries no quantity.`,
          profile.reference,
        );
      }
    } else {
      if (item.quantity < 0) {
        push(
          item,
          "quantity.negative",
          "error",
          "quantity",
          `Item "${item.code}" has a negative quantity (${item.quantity}); deductions belong on the dimension sheet, not in the bill.`,
          profile.reference,
        );
      }
      if (isLump && Math.abs(item.quantity - 1) > 1e-9 && unit !== "%") {
        push(
          item,
          "quantity.lump_not_one",
          "warning",
          "quantity",
          `Item "${item.code}" is billed as "${item.unit}" but carries a quantity of ${item.quantity}; a lump item is enumerated as 1.`,
          profile.reference,
        );
      }
      if (
        profile.wholeUnitRounding &&
        !isLump &&
        item.quantity !== 0 &&
        !quantityPresentationOk(item.quantity)
      ) {
        push(
          item,
          "quantity.rounding",
          "info",
          "quantity",
          `Quantity ${item.quantity} for "${item.code}" is not presented to the standard's rounding rule (whole units at or above 1, two decimals below 1).`,
          profile.reference,
        );
      }
    }

    if (isProvisional && !PROVISIONAL_WORDS.some((w) => lower.includes(w))) {
      push(
        item,
        "item_type.provisional_not_stated",
        "warning",
        "item_type",
        `Item "${item.code}" is typed ${item.itemType} but its description does not state that it is provisional.`,
        method === "nrm2" ? "NRM2 2.9 (provisional sums)" : profile.reference,
      );
    }
    if (item.itemType === "provisional_undefined" && item.quantity != null && !isLump) {
      push(
        item,
        "item_type.undefined_measured",
        "warning",
        "item_type",
        `Undefined provisional sum "${item.code}" is measured by quantity; an undefined provisional sum is a sum, not measured work.`,
        method === "nrm2" ? "NRM2 2.9.1.2" : profile.reference,
      );
    }
    if (item.itemType === "prime_cost" && !lower.includes("prime cost") && !lower.includes("pc sum")) {
      push(
        item,
        "item_type.pc_not_stated",
        "info",
        "item_type",
        `Item "${item.code}" is typed prime_cost; state "Prime Cost Sum" in the description so the bill reads correctly.`,
        method === "nrm2" ? "NRM2 2.10" : profile.reference,
      );
    }
    if (item.itemType === "daywork" && !profile.lumpUnits.includes(unit) && unit !== "hr" && unit !== "h") {
      push(
        item,
        "item_type.daywork_unit",
        "info",
        "unit",
        `Daywork item "${item.code}" is measured in "${item.unit}"; daywork is normally billed as a provisional sum or in hours with percentage additions.`,
        method === "nrm2" ? "NRM2 2.13 (dayworks)" : profile.reference,
      );
    }
    if (item.rate != null && item.quantity != null) {
      const expected = Math.round(item.quantity * item.rate * 100) / 100;
      if (item.amount != null && Math.abs(item.amount - expected) > 0.01) {
        push(
          item,
          "quantity.extension",
          "error",
          "quantity",
          `Item "${item.code}" extends to ${expected} (${item.quantity} × ${item.rate}) but carries ${item.amount}.`,
          "General: the extension must reconcile",
        );
      }
    }
  }

  /* --------------------- standard-specific extras -------------------- */

  if (method === "cesmm4") {
    // CESMM4 3.2: class letters run A-Z; an item outside the class list is
    // outside the standard's coding.
    for (const leaf of leaves) {
      const cls = leaf.code.trim().charAt(0);
      if (cls && !/^[A-Z]$/.test(cls)) {
        push(
          leaf,
          "cesmm4.class_letter",
          "warning",
          "code",
          `Item "${leaf.code}" does not begin with a CESMM4 class letter (A-Z).`,
          "CESMM4 Section 3, Work Classification",
        );
      }
    }
  }
  if (method === "nrm2") {
    const hasPrelims = leaves.some((l) => l.itemType.startsWith("prelims"));
    if (leaves.length > 0 && !hasPrelims) {
      push(
        null,
        "nrm2.no_preliminaries",
        "info",
        "structure",
        "No preliminaries items are billed; NRM2 measures main-contractor preliminaries as a distinct bill.",
        "NRM2 Part 2, Work Section 1 (Preliminaries)",
      );
    }
  }

  const counts = tally(findings);
  const denominator = Math.max(1, leaves.length);
  const penalty = (counts.error * 4 + counts.warning) / denominator;
  const complianceScore = Math.max(0, Math.round((1 - Math.min(1, penalty / 4)) * 100));

  return {
    method,
    standardName: profile.name,
    supported: true,
    itemsChecked: leaves.length,
    findings: sortFindings(findings),
    counts,
    complianceScore,
    notes,
  };
}

function tally(findings: MomFinding[]): { error: number; warning: number; info: number } {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity] += 1;
  return counts;
}

const SEVERITY_ORDER: Record<MomSeverity, number> = { error: 0, warning: 1, info: 2 };

function sortFindings(findings: MomFinding[]): MomFinding[] {
  return [...findings].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      (a.code ?? "").localeCompare(b.code ?? "", undefined, { numeric: true }) ||
      a.ruleId.localeCompare(b.ruleId),
  );
}

/** The standards this engine has a profile for, for the reference UI. */
export function measurementStandards(): Array<{
  method: string;
  name: string;
  units: string[];
  codeHint: string | null;
  reference: string;
}> {
  return Object.entries(PROFILES).map(([method, p]) => ({
    method,
    name: p.name,
    units: p.units,
    codeHint: p.codeHint ?? null,
    reference: p.reference,
  }));
}
