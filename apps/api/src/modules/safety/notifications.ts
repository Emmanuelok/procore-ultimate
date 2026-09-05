/**
 * SAFETY — STATUTORY NOTIFICATION, PER REGIME (M21).
 *
 * An incident can be answerable to more than one authority at once: a GB site
 * with a US parent reports the same amputation to the HSE under RIDDOR and to
 * OSHA under 29 CFR 1904.39, on two different clocks, to two different bodies,
 * on two different forms. They are two duties, and discharging one discharges
 * nothing of the other.
 *
 * The register used to carry a single `regulator_notified_at` column. Filing
 * the F2508 stamped it, and from that moment the OSHA eight-hour duty stopped
 * being tracked: the missed-notification sweep skipped the incident, the
 * drawer showed "notified", and the incident could be closed with a live
 * statutory duty undischarged. That is the class of defect this file exists to
 * remove.
 *
 * Everything here is pure. It takes a determination (or, for rows assessed
 * before the engine existed, the stored regime list and deadline), the
 * notifications actually recorded, and a clock reading; it returns one state
 * per duty and an aggregate. The route layer and the sweep share it, so the
 * screen, the signal and the close gate cannot disagree about whether a duty
 * is live.
 *
 * Deliberately NOT here: deciding whether a rule is met (reportability.ts),
 * or writing anything (index.ts).
 */

import type { NotificationDutyState } from "@constructos/shared";
import type { ReportabilityDetermination, RuleDetermination } from "./reportability.js";

/** One entry in `safety_incidents.notifications` — the jsonb is untyped. */
export interface NotificationEntry {
  regime: string;
  notifiedAt: string | null;
  reference: string | null;
  method: string | null;
  notifiedBy: string | null;
  late: boolean | null;
  hoursLate: number | null;
}

/** A duty owed to one authority under one regime. */
export interface RegimeDuty {
  regime: string;
  /** the rule that governs the deadline for this regime */
  ruleId: string | null;
  title: string;
  citation: string | null;
  authority: string | null;
  /** null when the regime is met but carries no notification deadline */
  dueAt: string | null;
  immediateNotificationRequired: boolean;
  notificationMethod: string | null;
  consequenceIfMissed: string | null;
}

export interface RegimeDutyState extends RegimeDuty {
  state: NotificationDutyState;
  notifiedAt: string | null;
  reference: string | null;
  method: string | null;
  /** hours past the deadline the notification was made, when it was late */
  hoursLate: number | null;
  /** hours left before the deadline, when it is still outstanding */
  hoursRemaining: number | null;
}

export interface NotificationState {
  duties: RegimeDutyState[];
  /** regimes with a live, undischarged duty */
  outstanding: string[];
  /** regimes whose deadline has passed with no notification, or a late one */
  missed: string[];
  notified: string[];
  /** every notifiable regime has a recorded notification */
  allDischarged: boolean;
  /** at least one deadline has been passed (whether or not later notified) */
  anyMissed: boolean;
  /** the earliest live deadline across regimes — what a countdown shows */
  earliestDueAt: string | null;
  /** true when a notification duty exists at all */
  required: boolean;
  reasons: string[];
}

const HOUR_MS = 3_600_000;

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * Which rule governs one regime's deadline: the earliest notifiable one. A
 * regime whose only met rules are recording duties (the OSHA 300 log) owes
 * nothing to an authority and gets a duty with `dueAt: null`, which is a
 * different statement from "no duty at all".
 */
export function regimeDuties(determination: ReportabilityDetermination): RegimeDuty[] {
  const met = determination.rules.filter((r) => r.outcome === "met");
  const byRegime = new Map<string, RuleDetermination[]>();
  for (const rule of met) {
    const list = byRegime.get(rule.regime);
    if (list) list.push(rule);
    else byRegime.set(rule.regime, [rule]);
  }

  const duties: RegimeDuty[] = [];
  for (const [regime, rules] of byRegime) {
    const notifiable = rules
      .filter((r) => !r.isRecordingDutyOnly && r.deadline != null)
      .sort((a, b) => Date.parse(a.deadline!.dueAt) - Date.parse(b.deadline!.dueAt));
    const governing = notifiable[0];
    if (!governing) continue; // recording-only: nothing is owed to an authority
    duties.push({
      regime,
      ruleId: governing.ruleId,
      title: governing.title,
      citation: governing.citation,
      authority: governing.authority,
      dueAt: governing.deadline!.dueAt,
      immediateNotificationRequired: governing.deadline!.immediateNotificationRequired,
      notificationMethod: governing.deadline!.notificationMethod,
      consequenceIfMissed: governing.consequenceIfMissed,
    });
  }
  duties.sort((a, b) => Date.parse(a.dueAt ?? "") - Date.parse(b.dueAt ?? ""));
  return duties;
}

/**
 * Duties for a row whose stored determination is missing or predates the
 * engine. The stored regime list and the single stored deadline are all there
 * is, so each regime is given that deadline and the reader is told why the
 * citation is absent.
 */
export function fallbackDuties(regimes: readonly string[], reportDueAt: string | null): RegimeDuty[] {
  return regimes
    .filter((r) => r !== "none")
    .map((regime) => ({
      regime,
      ruleId: null,
      title: `Statutory notification under ${regime}`,
      citation: null,
      authority: null,
      dueAt: reportDueAt,
      immediateNotificationRequired: false,
      notificationMethod: null,
      consequenceIfMissed: null,
    }));
}

export interface NotificationStateInput {
  /** the stored determination, when the incident has one */
  determination: ReportabilityDetermination | null;
  /** `safety_incidents.reportable_regimes` — the fallback regime list */
  storedRegimes: readonly string[];
  /** `safety_incidents.report_due_at` — the fallback deadline */
  reportDueAt: string | null;
  /** `safety_incidents.notifications` */
  notifications: readonly NotificationEntry[];
  /** whether the incident is classified reportable at all */
  isReportable: boolean;
  asOfISO: string;
}

/**
 * The standing of every statutory notification duty on one incident.
 *
 * A duty is `notified` when an entry for its regime exists and predates the
 * deadline, `notified_late` when the entry exists but the deadline had already
 * passed, `missed` when no entry exists and the deadline has passed, and
 * `outstanding` while the clock still runs. `allDischarged` — the only thing
 * the close gate and the single stored `regulator_notified_at` column may be
 * driven from — is true when NO duty is outstanding or missed.
 */
export function notificationState(input: NotificationStateInput): NotificationState {
  const reasons: string[] = [];
  let duties: RegimeDuty[];
  if (input.determination) {
    duties = regimeDuties(input.determination);
    if (duties.length === 0 && input.isReportable) {
      reasons.push(
        "The determination records met rules but none of them carries a notification deadline — " +
          "they are recording duties. Nothing is owed to an authority.",
      );
    }
  } else {
    duties = fallbackDuties(input.storedRegimes, input.reportDueAt);
    if (duties.length > 0) {
      reasons.push(
        "This incident carries no stored determination, so the deadline shown against each regime is " +
          "the single stored `reportDueAt` and no citation is available. Reassess it to get the " +
          "per-regime clocks and the rules behind them.",
      );
    }
  }

  const entryByRegime = new Map<string, NotificationEntry>();
  for (const entry of input.notifications) {
    if (typeof entry?.regime !== "string") continue;
    const existing = entryByRegime.get(entry.regime);
    // the FIRST notification under a regime is the one the duty turns on
    if (!existing) entryByRegime.set(entry.regime, entry);
    else if (
      entry.notifiedAt &&
      existing.notifiedAt &&
      Date.parse(entry.notifiedAt) < Date.parse(existing.notifiedAt)
    ) {
      entryByRegime.set(entry.regime, entry);
    }
  }

  const asOf = Date.parse(input.asOfISO);
  const states: RegimeDutyState[] = duties.map((duty) => {
    const entry = entryByRegime.get(duty.regime) ?? null;
    const due = duty.dueAt ? Date.parse(duty.dueAt) : null;
    if (entry && entry.notifiedAt) {
      const notified = Date.parse(entry.notifiedAt);
      const late = due != null && Number.isFinite(due) && notified > due;
      return {
        ...duty,
        state: late ? "notified_late" : "notified",
        notifiedAt: entry.notifiedAt,
        reference: entry.reference ?? null,
        method: entry.method ?? null,
        hoursLate: late && due != null ? round1((notified - due) / HOUR_MS) : null,
        hoursRemaining: null,
      };
    }
    if (due == null || !Number.isFinite(due)) {
      return {
        ...duty,
        state: "outstanding",
        notifiedAt: null,
        reference: null,
        method: null,
        hoursLate: null,
        hoursRemaining: null,
      };
    }
    const missed = asOf > due;
    return {
      ...duty,
      state: missed ? "missed" : "outstanding",
      notifiedAt: null,
      reference: null,
      method: null,
      hoursLate: missed ? round1((asOf - due) / HOUR_MS) : null,
      hoursRemaining: missed ? null : round1((due - asOf) / HOUR_MS),
    };
  });

  const outstanding = states.filter((d) => d.state === "outstanding").map((d) => d.regime);
  const missed = states.filter((d) => d.state === "missed" || d.state === "notified_late").map((d) => d.regime);
  const notified = states
    .filter((d) => d.state === "notified" || d.state === "notified_late")
    .map((d) => d.regime);

  const live = states.filter((d) => d.state === "outstanding" && d.dueAt != null);
  live.sort((a, b) => Date.parse(a.dueAt!) - Date.parse(b.dueAt!));

  /* Notifications recorded under a regime that carries no met rule are kept
   * and reported: somebody told an authority something, and a register that
   * silently drops that is worse than one that questions it. */
  for (const [regime] of entryByRegime) {
    if (!duties.some((d) => d.regime === regime)) {
      reasons.push(
        `A notification is recorded under \`${regime}\`, but the current determination finds no met ` +
          `notifiable rule for that regime. Either the classification has changed since the report ` +
          `was made or the regime was reported out of caution — both are worth a note on the file.`,
      );
    }
  }

  return {
    duties: states,
    outstanding,
    missed: [...new Set(missed)],
    notified,
    /* Discharged means EVERY duty has a recorded notification. A duty whose
     * deadline has passed with nothing filed is `missed`, not `outstanding`,
     * and treating the absence of an outstanding clock as discharge is how the
     * missed duty would have vanished from the close gate a second time. */
    allDischarged:
      states.length > 0 &&
      states.every((d) => d.state === "notified" || d.state === "notified_late"),
    anyMissed: states.some((d) => d.state === "missed" || d.state === "notified_late"),
    earliestDueAt: live[0]?.dueAt ?? null,
    required: states.length > 0,
    reasons,
  };
}

/**
 * The value `regulator_notified_at` may take. It is a DERIVED summary of the
 * per-regime entries, not an independent fact: it is set only once every
 * notifiable regime has been notified, and it carries the LAST of those
 * timestamps, because that is the moment the incident's statutory duties were
 * finally discharged. Setting it on the first notification is what let a live
 * duty vanish from the register.
 */
export function derivedRegulatorNotifiedAt(state: NotificationState): string | null {
  if (!state.allDischarged) return null;
  const times = state.duties
    .map((d) => d.notifiedAt)
    .filter((t): t is string => typeof t === "string" && Number.isFinite(Date.parse(t)));
  if (times.length === 0) return null;
  return times.reduce((latest, t) => (Date.parse(t) > Date.parse(latest) ? t : latest));
}

/** The signal key for one regime's missed duty — one finding per duty. */
export const missedNotificationKey = (incidentId: string, regime: string): string =>
  `${incidentId}:${regime}`;
