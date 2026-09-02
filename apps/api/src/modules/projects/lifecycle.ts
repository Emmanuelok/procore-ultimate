/**
 * Project lifecycle rules — stage transitions, currency changes and deletion
 * eligibility (Vol I §0.3 #49–#53, #78).
 *
 * These were unguarded: `PATCH /projects/:id` at `projects:standard` accepted
 * any stage from any stage (a closed project could be moved back to bidding),
 * and accepted a currency change on a project already holding contracts,
 * budgets and invoices denominated in the old one — which silently
 * recontextualised every money tile on the command centre without moving a
 * single stored amount.
 *
 * Pure functions, so the rules are readable in one place and testable without
 * a database.
 */
import { PROJECT_STAGES, type ProjectStage } from "@constructos/shared";

/**
 * The forward path a project takes. Reversals are legal but privileged: they
 * are an admin correction, not a standard edit.
 */
const FORWARD: Record<ProjectStage, ProjectStage[]> = {
  bidding: ["pre_construction", "closed"],
  pre_construction: ["course_of_construction", "closed"],
  course_of_construction: ["warranty", "closed"],
  warranty: ["closed"],
  closed: [],
};

export type StageDecision =
  | { allowed: true; requiresAdmin: boolean }
  | { allowed: false; reason: string };

/**
 * May `from` become `to`?
 *
 * Forward moves along the path are ordinary. Anything else — skipping a
 * stage, or going back — is allowed only at `projects:admin`, and reopening
 * a closed project is always an admin act.
 */
export function stageTransition(from: string, to: string): StageDecision {
  if (from === to) return { allowed: true, requiresAdmin: false };
  if (!PROJECT_STAGES.includes(to as ProjectStage)) {
    return { allowed: false, reason: `"${to}" is not a project stage` };
  }
  if (!PROJECT_STAGES.includes(from as ProjectStage)) {
    // An unknown current stage (hand-edited data) may only be corrected by an
    // admin, never advanced by a standard edit.
    return { allowed: true, requiresAdmin: true };
  }
  const forward = FORWARD[from as ProjectStage] ?? [];
  if (forward.includes(to as ProjectStage)) return { allowed: true, requiresAdmin: false };
  return { allowed: true, requiresAdmin: true };
}

/** The stages a caller at this level may move to, for the UI's picker. */
export function allowedNextStages(from: string, isAdmin: boolean): ProjectStage[] {
  if (isAdmin) return [...PROJECT_STAGES];
  return FORWARD[from as ProjectStage] ?? [];
}

export interface MoneyFootprint {
  /** table label → how many rows carry a currency for this project */
  counts: Record<string, number>;
  currencies: string[];
}

export type CurrencyDecision =
  | { allowed: true }
  | { allowed: false; reason: string; details: MoneyFootprint };

/**
 * May the project's currency change?
 *
 * Only while nothing denominated in the old currency exists. Amounts are
 * stored as plain numbers with the project's currency as their context, so
 * flipping the context silently restates every figure — the one thing the
 * honesty rules forbid.
 */
export function currencyChange(
  from: string,
  to: string,
  footprint: MoneyFootprint,
): CurrencyDecision {
  if (from === to) return { allowed: true };
  const held = Object.entries(footprint.counts).filter(([, n]) => n > 0);
  if (held.length === 0) return { allowed: true };
  return {
    allowed: false,
    reason: `This project already holds money records in ${from}: ${held
      .map(([label, n]) => `${n} ${label}`)
      .join(", ")}. Changing the currency would restate them without converting them.`,
    details: footprint,
  };
}

/** ISO date validation shared by the project date fields. */
export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.slice(0, 10))) return false;
  return !Number.isNaN(Date.parse(`${value.slice(0, 10)}T00:00:00Z`));
}

export type DateDecision = { ok: true } | { ok: false; reason: string };

export function validateProjectDates(
  startDate: string | null | undefined,
  finishDate: string | null | undefined,
): DateDecision {
  if (startDate && !isIsoDate(startDate)) {
    return { ok: false, reason: "startDate must be an ISO date (YYYY-MM-DD)" };
  }
  if (finishDate && !isIsoDate(finishDate)) {
    return { ok: false, reason: "finishDate must be an ISO date (YYYY-MM-DD)" };
  }
  if (startDate && finishDate && finishDate.slice(0, 10) < startDate.slice(0, 10)) {
    return { ok: false, reason: "finishDate cannot be before startDate" };
  }
  return { ok: true };
}
