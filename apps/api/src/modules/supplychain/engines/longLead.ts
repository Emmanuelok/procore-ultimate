/**
 * LONG-LEAD ENGINE — order-by-date and risk-of-late (spec #918–920, #727).
 *
 * The one question a long-lead register answers: "if we do not order this by
 * X, the programme slips." X is `requiredOnSite − leadTime − buffer`. Float is
 * the days between when the item will actually be on site and when the
 * programme needs it; the risk level reads the float, the milestone slippage
 * and the expediting history together and says WHY.
 *
 * Deterministic and pure: no clock, no database. `today` is an input.
 */
import type { LongLeadRiskLevel, LongLeadStatus } from "@constructos/shared";
import { addDays, daysBetween } from "./dates.js";

export interface LongLeadInput {
  status: LongLeadStatus | string;
  requiredOnSite: string | null;
  leadTimeDays: number;
  bufferDays: number;
  plannedOrderDate: string | null;
  actualOrderDate: string | null;
  plannedShipDate: string | null;
  actualShipDate: string | null;
  plannedArrivalDate: string | null;
  forecastArrivalDate: string | null;
  actualArrivalDate: string | null;
  customsRequired: boolean;
  customsClearedAt: string | null;
  lastExpeditedAt: string | null;
  /** the criticality of the supplying node, when the item is linked to one */
  supplierCriticality?: string | null;
  /** whether the feeding schedule task is on the critical path */
  taskIsCritical?: boolean;
}

export interface LongLeadAssessment {
  orderByDate: string | null;
  /** the date the engine expects the item to be on site, and where it came from */
  expectedOnSite: string | null;
  expectedOnSiteBasis: "actual_arrival" | "forecast" | "planned_arrival" | "order_plus_lead" | "today_plus_lead" | "none";
  floatDays: number | null;
  riskLevel: LongLeadRiskLevel;
  reasons: string[];
  /** days by which the order-by date has been missed (positive = late to order) */
  orderLatenessDays: number | null;
}

const CLOSED: ReadonlySet<string> = new Set(["installed", "cancelled"]);
const ORDERED_OR_LATER: ReadonlySet<string> = new Set([
  "ordered",
  "in_production",
  "shipped",
  "in_customs",
  "arrived",
  "installed",
]);

/** `requiredOnSite − leadTime − buffer`, or null without a need date. */
export function computeOrderByDate(input: Pick<LongLeadInput, "requiredOnSite" | "leadTimeDays" | "bufferDays">): string | null {
  if (!input.requiredOnSite) return null;
  const lead = Math.max(0, Math.floor(input.leadTimeDays || 0));
  const buffer = Math.max(0, Math.floor(input.bufferDays || 0));
  return addDays(input.requiredOnSite, -(lead + buffer));
}

/**
 * The date the item is expected on site, taking the most reliable evidence
 * first: an actual arrival, then the supplier's forecast, then the planned
 * arrival, then order date + lead time, then (unordered) today + lead time.
 */
export function expectedOnSite(
  input: LongLeadInput,
  today: string,
): { date: string | null; basis: LongLeadAssessment["expectedOnSiteBasis"] } {
  if (input.actualArrivalDate) return { date: input.actualArrivalDate, basis: "actual_arrival" };
  if (input.forecastArrivalDate) return { date: input.forecastArrivalDate, basis: "forecast" };
  if (input.plannedArrivalDate) return { date: input.plannedArrivalDate, basis: "planned_arrival" };
  const lead = Math.max(0, Math.floor(input.leadTimeDays || 0));
  if (input.actualOrderDate) return { date: addDays(input.actualOrderDate, lead), basis: "order_plus_lead" };
  if (lead > 0 || input.requiredOnSite) return { date: addDays(today, lead), basis: "today_plus_lead" };
  return { date: null, basis: "none" };
}

export function assessLongLead(input: LongLeadInput, today: string): LongLeadAssessment {
  const reasons: string[] = [];
  const orderByDate = computeOrderByDate(input);

  if (CLOSED.has(input.status)) {
    return {
      orderByDate,
      expectedOnSite: input.actualArrivalDate,
      expectedOnSiteBasis: input.actualArrivalDate ? "actual_arrival" : "none",
      floatDays: null,
      riskLevel: "on_track",
      reasons: [`Item is ${input.status}; no further risk of late arrival.`],
      orderLatenessDays: null,
    };
  }

  if (!input.requiredOnSite) {
    reasons.push(
      "No required-on-site date: link the item to a schedule task or enter the date, and the order-by date follows.",
    );
    return {
      orderByDate: null,
      expectedOnSite: expectedOnSite(input, today).date,
      expectedOnSiteBasis: expectedOnSite(input, today).basis,
      floatDays: null,
      riskLevel: "not_assessable",
      reasons,
      orderLatenessDays: null,
    };
  }

  const expected = expectedOnSite(input, today);
  const floatDays = daysBetween(expected.date, input.requiredOnSite);
  const isOrdered = ORDERED_OR_LATER.has(input.status) || Boolean(input.actualOrderDate);
  const orderLatenessDays = !isOrdered && orderByDate ? daysBetween(orderByDate, today) : null;

  const state: { level: LongLeadRiskLevel } = { level: "on_track" };
  const escalate = (to: LongLeadRiskLevel) => {
    const rank: Record<LongLeadRiskLevel, number> = {
      not_assessable: -1,
      on_track: 0,
      watch: 1,
      at_risk: 2,
      late: 3,
    };
    if (rank[to] > rank[state.level]) state.level = to;
  };

  /* 1. Already late on site */
  if (input.actualArrivalDate && floatDays !== null && floatDays < 0) {
    escalate("late");
    reasons.push(`Arrived ${-floatDays} day(s) after the required-on-site date ${input.requiredOnSite}.`);
  } else if (floatDays !== null && floatDays < 0) {
    escalate("late");
    reasons.push(
      `Expected on site ${expected.date} (${basisLabel(expected.basis)}), ${-floatDays} day(s) after it is needed on ${input.requiredOnSite}.`,
    );
  }

  /* 2. Not ordered and the order-by date has passed or is close */
  if (!isOrdered && orderByDate) {
    const daysToOrderBy = daysBetween(today, orderByDate);
    if (daysToOrderBy !== null && daysToOrderBy < 0) {
      escalate("late");
      reasons.push(
        `Not yet ordered and the order-by date ${orderByDate} passed ${-daysToOrderBy} day(s) ago (lead time ${input.leadTimeDays}d + buffer ${input.bufferDays}d).`,
      );
    } else if (daysToOrderBy !== null && daysToOrderBy <= 14) {
      escalate("at_risk");
      reasons.push(`Not yet ordered; the order-by date ${orderByDate} is ${daysToOrderBy} day(s) away.`);
    } else if (daysToOrderBy !== null && daysToOrderBy <= 30) {
      escalate("watch");
      reasons.push(`Not yet ordered; order by ${orderByDate} (${daysToOrderBy} days).`);
    }
  }

  /* 3. Float thin */
  if (floatDays !== null && floatDays >= 0) {
    if (floatDays <= 3) {
      escalate("at_risk");
      reasons.push(`Only ${floatDays} day(s) of float between expected arrival (${expected.date}) and need (${input.requiredOnSite}).`);
    } else if (floatDays <= 10) {
      escalate("watch");
      reasons.push(`${floatDays} day(s) of float between expected arrival and need.`);
    }
  }

  /* 4. Milestone slippage against plan */
  if (isOrdered && input.plannedShipDate && !input.actualShipDate) {
    const overdue = daysBetween(input.plannedShipDate, today);
    if (overdue !== null && overdue > 0) {
      escalate(overdue > 7 ? "at_risk" : "watch");
      reasons.push(`Planned ship date ${input.plannedShipDate} passed ${overdue} day(s) ago with no shipment recorded.`);
    }
  }
  if (input.actualShipDate && input.customsRequired && !input.customsClearedAt && !input.actualArrivalDate) {
    const inTransit = daysBetween(input.actualShipDate, today);
    if (inTransit !== null && inTransit > 21) {
      escalate("watch");
      reasons.push(`Shipped ${inTransit} day(s) ago and customs clearance is not yet recorded.`);
    }
  }
  if (input.forecastArrivalDate && input.plannedArrivalDate) {
    const slip = daysBetween(input.plannedArrivalDate, input.forecastArrivalDate);
    if (slip !== null && slip > 0) {
      reasons.push(`Supplier forecast has slipped ${slip} day(s) past the planned arrival ${input.plannedArrivalDate}.`);
      if (slip > 14) escalate("watch");
    }
  }

  /* 5. Expediting neglect on an item that is already at risk */
  if (state.level !== "on_track" && isOrdered && !input.actualArrivalDate) {
    const sinceChase = input.lastExpeditedAt ? daysBetween(input.lastExpeditedAt.slice(0, 10), today) : null;
    if (sinceChase === null) reasons.push("No expediting contact has ever been logged.");
    else if (sinceChase > 14) reasons.push(`Last expedited ${sinceChase} day(s) ago.`);
  }

  /* 6. Context: critical path amplifies watch → at_risk */
  if ((input.taskIsCritical || input.supplierCriticality === "critical") && state.level === "watch") {
    escalate("at_risk");
    reasons.push(
      input.taskIsCritical
        ? "The feeding task is on the critical path: any slip moves the finish date."
        : "The supplier is rated critical (single-source or no alternative).",
    );
  }

  if (state.level === "on_track" && reasons.length === 0) {
    reasons.push(
      floatDays !== null
        ? `${floatDays} day(s) of float: expected on site ${expected.date} (${basisLabel(expected.basis)}) against need on ${input.requiredOnSite}.`
        : "No conflict detected.",
    );
  }

  return {
    orderByDate,
    expectedOnSite: expected.date,
    expectedOnSiteBasis: expected.basis,
    floatDays,
    riskLevel: state.level,
    reasons,
    orderLatenessDays,
  };
}

function basisLabel(basis: LongLeadAssessment["expectedOnSiteBasis"]): string {
  switch (basis) {
    case "actual_arrival":
      return "actual arrival";
    case "forecast":
      return "supplier forecast";
    case "planned_arrival":
      return "planned arrival";
    case "order_plus_lead":
      return "order date + lead time";
    case "today_plus_lead":
      return "if ordered today + lead time";
    default:
      return "no basis";
  }
}

/** The status a milestone advances an item to. */
export function statusAfterMilestone(milestone: string): LongLeadStatus | null {
  switch (milestone) {
    case "requisitioned":
      return "requisitioned";
    case "ordered":
      return "ordered";
    case "production_started":
      return "in_production";
    case "shipped":
      return "shipped";
    case "customs_cleared":
      return "in_customs";
    case "arrived":
      return "arrived";
    case "installed":
      return "installed";
    default:
      return null;
  }
}

/** Milestones must be recorded in lifecycle order; a skipped step is refused. */
export const LONG_LEAD_ORDER: readonly LongLeadStatus[] = [
  "identified",
  "requisitioned",
  "ordered",
  "in_production",
  "shipped",
  "in_customs",
  "arrived",
  "installed",
];

export function milestoneAllowed(current: string, next: LongLeadStatus): { ok: boolean; reason?: string } {
  if (current === "cancelled") return { ok: false, reason: "The item is cancelled." };
  const from = LONG_LEAD_ORDER.indexOf(current as LongLeadStatus);
  const to = LONG_LEAD_ORDER.indexOf(next);
  if (to < 0) return { ok: false, reason: `Unknown milestone ${next}.` };
  if (to <= from) return { ok: false, reason: `Item is already ${current}; ${next} would move it backwards.` };
  // in_customs is optional: shipped → arrived is fine. Everything else must be adjacent.
  if (to - from > 1 && !(current === "shipped" && next === "arrived") && !(current === "identified" && next === "ordered")) {
    return {
      ok: false,
      reason: `Record ${LONG_LEAD_ORDER[from + 1]} before ${next}: milestones are the audit trail of the order.`,
    };
  }
  return { ok: true };
}

/** Expediting backlog: ordered, not arrived, and not chased in `staleDays`. */
export function isExpeditingStale(
  item: Pick<LongLeadInput, "status" | "lastExpeditedAt" | "actualArrivalDate">,
  today: string,
  staleDays = 14,
): boolean {
  if (!ORDERED_OR_LATER.has(item.status) || item.actualArrivalDate || item.status === "arrived") return false;
  if (!item.lastExpeditedAt) return true;
  const since = daysBetween(item.lastExpeditedAt.slice(0, 10), today);
  return since !== null && since > staleDays;
}
