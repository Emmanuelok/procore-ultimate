/**
 * Concurrency, pacing and float ownership (spec Vol II Domain D #278-281) —
 * pure.
 *
 * The question a tribunal actually asks is not "did two delays overlap" but
 * "would completion have moved anyway". So each event is tested THREE ways
 * against the same network:
 *
 *   alone(A)     — insert only A's fragnet; does completion move?
 *   alone(B)     — insert only B's fragnet; does completion move?
 *   together(AB) — insert both; how far does completion move?
 *
 * From which:
 *   TRUE CONCURRENCY  both drive independently and their effects overlap in
 *                     time — together ≈ max(alone) rather than the sum.
 *   SEQUENTIAL        both drive but their effects add up.
 *   PACING            one event does not drive on its own and its float
 *                     consumption tracks the driving one within the pacing
 *                     tolerance: a deliberate slowdown in step with someone
 *                     else's delay is not a delay of its own.
 *   INDEPENDENT       neither drives, or they do not overlap.
 *
 * Entitlement then follows the project's recorded doctrine, not the analyst's
 * preference: SCL Protocol (EOT yes, money no), Malmaison (same effect via a
 * different route), or apportionment (City Inn — shared). The rule applied is
 * cited on every recommendation.
 *
 * FLOAT OWNERSHIP decides whether consuming float — without moving completion
 * — creates entitlement at all: "project"/"first_come" float belongs to
 * whoever needs it first, so no; contractor-owned float means owner delay
 * eating it is compensable; owner-owned float means the reverse.
 */

import type { ConcurrencyRule, CulpableParty, FloatOwnershipRule } from "@constructos/shared";
import { computeCpm2 } from "../schedule/cpm2.js";
import { insertFragnet, type ForensicEvent, type ForensicNetwork, type MethodFailure } from "./methods.js";

export interface FloatRules {
  ownership: FloatOwnershipRule;
  concurrencyRule: ConcurrencyRule;
  concurrencyThresholdDays: number;
  pacingThresholdDays: number;
  basis?: string | null;
}

export const DEFAULT_FLOAT_RULES: FloatRules = {
  ownership: "project",
  concurrencyRule: "sca_protocol",
  concurrencyThresholdDays: 1,
  pacingThresholdDays: 2,
};

export type ConcurrencyClassification =
  | "true_concurrency"
  | "sequential"
  | "pacing"
  | "independent";

export interface EventImpact {
  eventId: string;
  title: string;
  party: CulpableParty | string;
  startDate: string;
  endDate: string;
  durationDays: number;
  /** completion movement when this event alone is inserted */
  deltaAlone: number | null;
  driving: boolean;
  /** float consumed on the struck activity by this event */
  floatConsumedDays: number | null;
  reason?: string;
}

export interface ConcurrencyPair {
  aId: string;
  bId: string;
  aTitle: string;
  bTitle: string;
  aParty: string;
  bParty: string;
  overlapDays: number;
  deltaAlone: { a: number | null; b: number | null };
  deltaTogether: number | null;
  classification: ConcurrencyClassification;
  rationale: string;
}

export interface EntitlementRecommendation {
  eventId: string;
  title: string;
  party: string;
  /** "yes" | "no" | "shared" — shared means apportioned under the doctrine */
  time: "yes" | "no" | "shared";
  money: "yes" | "no" | "shared";
  classification: ConcurrencyClassification;
  concurrentWith: string[];
  rule: string;
  explanation: string;
}

export interface ConcurrencyResult {
  ok: true;
  rules: FloatRules;
  impacts: EventImpact[];
  pairs: ConcurrencyPair[];
  recommendations: EntitlementRecommendation[];
}

const DAY_MS = 86_400_000;
const dayOf = (iso: string): number => Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY_MS);
const addDays = (iso: string, n: number): string =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** Inclusive-day overlap of two [start, start+duration) spans. */
export function overlapDays(a: ForensicEvent, b: ForensicEvent): number {
  const aStart = dayOf(a.startDate);
  const aEnd = aStart + Math.max(1, a.durationDays);
  const bStart = dayOf(b.startDate);
  const bEnd = bStart + Math.max(1, b.durationDays);
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

const RULE_LABEL: Record<ConcurrencyRule, string> = {
  sca_protocol: "SCL Delay & Disruption Protocol (2nd ed.) Core Principle 10 — concurrent delay gives EOT but not compensation",
  malmaison: "Henry Boot v Malmaison — where two concurrent causes operate, the contractor is entitled to an extension for the relevant event",
  apportionment: "City Inn v Shepherd (apportionment) — time and money are apportioned between the causes",
};

export function analyseConcurrency(
  network: ForensicNetwork,
  events: ForensicEvent[],
  rules: FloatRules = DEFAULT_FLOAT_RULES,
): ConcurrencyResult | MethodFailure {
  const base = computeCpm2(network.tasks, network.deps, {
    projectStart: network.projectStart,
    dataDate: network.dataDate ?? null,
    calendars: network.calendars,
    defaultCalendarId: network.defaultCalendarId ?? null,
  });
  if (!base.ok) {
    return { ok: false, reason: "The network contains a dependency cycle", cycle: base.cycle };
  }

  const known = new Set(network.tasks.map((t) => t.id));
  const runWith = (list: ForensicEvent[]): number | null => {
    let tasks = network.tasks;
    let deps = network.deps;
    for (const e of list) {
      const next = insertFragnet(tasks, deps, e);
      tasks = next.tasks;
      deps = next.deps;
    }
    const res = computeCpm2(tasks, deps, {
      projectStart: network.projectStart,
      dataDate: network.dataDate ?? null,
      calendars: network.calendars,
      defaultCalendarId: network.defaultCalendarId ?? null,
    });
    return res.ok ? res.projectDurationDays - base.projectDurationDays : null;
  };

  /* ---- per-event impact ---- */
  const impacts: EventImpact[] = [];
  const usable: ForensicEvent[] = [];
  for (const e of events) {
    const endDate = addDays(e.startDate, Math.max(0, e.durationDays - 1));
    if (!e.struckTaskId || !known.has(e.struckTaskId)) {
      impacts.push({
        eventId: e.id,
        title: e.title,
        party: e.party ?? "neither",
        startDate: e.startDate,
        endDate,
        durationDays: e.durationDays,
        deltaAlone: null,
        driving: false,
        floatConsumedDays: null,
        reason: e.struckTaskId
          ? "the struck activity is not in this network"
          : "the event does not name a struck activity",
      });
      continue;
    }
    const delta = runWith([e]);
    const struckFloat = base.tasks.get(e.struckTaskId)?.totalFloat ?? null;
    impacts.push({
      eventId: e.id,
      title: e.title,
      party: e.party ?? "neither",
      startDate: e.startDate,
      endDate,
      durationDays: e.durationDays,
      deltaAlone: delta,
      driving: delta !== null && delta > 0,
      floatConsumedDays:
        struckFloat === null ? null : Math.min(Math.max(struckFloat, 0), e.durationDays),
    });
    usable.push(e);
  }
  const impactById = new Map(impacts.map((i) => [i.eventId, i] as const));

  /* ---- pairwise classification ---- */
  const pairs: ConcurrencyPair[] = [];
  const concurrentWith = new Map<string, string[]>();
  const pacingOf = new Map<string, string>();
  for (let i = 0; i < usable.length; i += 1) {
    for (let j = i + 1; j < usable.length; j += 1) {
      const a = usable[i]!;
      const b = usable[j]!;
      const overlap = overlapDays(a, b);
      const ia = impactById.get(a.id)!;
      const ib = impactById.get(b.id)!;
      const together = runWith([a, b]);
      let classification: ConcurrencyClassification = "independent";
      let rationale: string;

      if (overlap < rules.concurrencyThresholdDays) {
        classification = "independent";
        rationale = `The events overlap by ${overlap} day(s), below the project's ${rules.concurrencyThresholdDays}-day concurrency threshold.`;
      } else if (ia.driving && ib.driving) {
        const sum = (ia.deltaAlone ?? 0) + (ib.deltaAlone ?? 0);
        const maxAlone = Math.max(ia.deltaAlone ?? 0, ib.deltaAlone ?? 0);
        if (together !== null && together < sum - 0.5 && together <= maxAlone + rules.concurrencyThresholdDays) {
          classification = "true_concurrency";
          rationale =
            `Each event moves completion on its own (${ia.deltaAlone}d and ${ib.deltaAlone}d) and together they move it ` +
            `${together}d — less than the ${sum}d they would add sequentially, so their effects overlap.`;
        } else {
          classification = "sequential";
          rationale =
            `Both events drive, and together they move completion ${together ?? "?"}d — the sum of their separate effects, ` +
            "so they act one after the other rather than concurrently.";
        }
      } else if (ia.driving !== ib.driving) {
        const passive = ia.driving ? ib : ia;
        const driver = ia.driving ? ia : ib;
        const passiveFloat = passive.floatConsumedDays ?? 0;
        const driverDelta = driver.deltaAlone ?? 0;
        if (Math.abs(passiveFloat - driverDelta) <= rules.pacingThresholdDays && overlap > 0) {
          classification = "pacing";
          pacingOf.set(passive.eventId, driver.eventId);
          rationale =
            `"${passive.title}" does not move completion on its own and consumes ${passiveFloat}d of float while ` +
            `"${driver.title}" drives ${driverDelta}d — within the ${rules.pacingThresholdDays}-day pacing tolerance, so it reads as pacing.`;
        } else {
          classification = "independent";
          rationale = `Only "${driver.title}" moves completion; "${passive.title}" sits on float and does not.`;
        }
      } else {
        classification = "independent";
        rationale = "Neither event moves completion on its own.";
      }

      if (classification === "true_concurrency") {
        concurrentWith.set(a.id, [...(concurrentWith.get(a.id) ?? []), b.id]);
        concurrentWith.set(b.id, [...(concurrentWith.get(b.id) ?? []), a.id]);
      }

      pairs.push({
        aId: a.id,
        bId: b.id,
        aTitle: a.title,
        bTitle: b.title,
        aParty: a.party ?? "neither",
        bParty: b.party ?? "neither",
        overlapDays: overlap,
        deltaAlone: { a: ia.deltaAlone, b: ib.deltaAlone },
        deltaTogether: together,
        classification,
        rationale,
      });
    }
  }

  /* ---- entitlement recommendation per event ---- */
  const recommendations: EntitlementRecommendation[] = [];
  for (const e of events) {
    const impact = impactById.get(e.id)!;
    const party = (e.party ?? "neither") as string;
    const concurrent = concurrentWith.get(e.id) ?? [];
    const opposedConcurrent = concurrent.filter((id) => {
      const other = events.find((x) => x.id === id);
      return other && (other.party ?? "neither") !== party;
    });
    const paced = pacingOf.get(e.id);
    let classification: ConcurrencyClassification = paced
      ? "pacing"
      : opposedConcurrent.length > 0
        ? "true_concurrency"
        : impact.driving
          ? "sequential"
          : "independent";

    let time: EntitlementRecommendation["time"] = "no";
    let money: EntitlementRecommendation["money"] = "no";
    let rule = "Critical-path causation: only delay that moves completion earns time.";
    let explanation: string;

    if (impact.deltaAlone === null) {
      explanation =
        impact.reason ??
        "This event could not be modelled against the network, so no entitlement can be computed from it.";
      classification = "independent";
    } else if (paced) {
      explanation =
        `This event paces "${events.find((x) => x.id === paced)?.title ?? paced}" — the float it consumes tracks the driving ` +
        "delay, so it is a deliberate re-sequencing rather than a delay in its own right and carries no entitlement.";
      rule = "SCL Protocol Core Principle 14 (pacing)";
    } else if (party === "contractor") {
      explanation = impact.driving
        ? "Contractor-culpable delay driving the critical path: no extension and no compensation; it is the contractor's own delay."
        : "Contractor-culpable delay that does not move completion.";
    } else if (opposedConcurrent.length > 0) {
      const titles = opposedConcurrent
        .map((id) => events.find((x) => x.id === id)?.title ?? id)
        .join(", ");
      rule = RULE_LABEL[rules.concurrencyRule];
      if (rules.concurrencyRule === "apportionment") {
        time = "shared";
        money = "shared";
        explanation = `Concurrent with ${titles}. Under the project's recorded apportionment doctrine, time and money are shared between the causes.`;
      } else {
        time = "yes";
        money = "no";
        explanation =
          `Concurrent with ${titles}. Under the project's recorded doctrine an extension of time is granted, ` +
          "but prolongation cost is not recoverable for the period of concurrency.";
      }
    } else if (impact.driving) {
      time = e.excusable === false ? "no" : "yes";
      money = e.compensable ? "yes" : "no";
      explanation =
        `This event moves completion by ${impact.deltaAlone} day(s) on its own and is not concurrent with an opposing cause. ` +
        (e.compensable
          ? "It is classified compensable, so both time and money follow."
          : "It is classified excusable but not compensable, so time follows and money does not.");
    } else {
      // Non-driving: float ownership decides whether consuming float pays.
      const consumed = impact.floatConsumedDays ?? 0;
      if (rules.ownership === "contractor" && party === "owner" && consumed > 0) {
        money = "yes";
        rule = "Project float doctrine: float is owned by the contractor";
        explanation =
          `The event does not move completion but consumes ${consumed} day(s) of float that the contract allocates to the ` +
          "contractor, so the cost of that consumption is recoverable even though no extension arises.";
      } else if (rules.ownership === "owner" && party === "contractor" && consumed > 0) {
        rule = "Project float doctrine: float is owned by the employer";
        explanation =
          `The event consumes ${consumed} day(s) of employer-owned float without moving completion — no entitlement, and the ` +
          "consumption is recorded against the contractor.";
      } else {
        rule =
          rules.ownership === "first_come"
            ? "Project float doctrine: float belongs to whoever needs it first"
            : "Project float doctrine: float belongs to the project";
        explanation =
          `The event sits on ${consumed} day(s) of available float and does not move completion, so no extension of time arises.`;
      }
    }

    recommendations.push({
      eventId: e.id,
      title: e.title,
      party,
      time,
      money,
      classification,
      concurrentWith: opposedConcurrent,
      rule,
      explanation,
    });
  }

  return { ok: true, rules, impacts, pairs, recommendations };
}
