/**
 * SAFETY — LEADING-INDICATOR RISK INDEX AND UNDER-REPORTING DETECTION
 * (Vol II M #701–702; Vol I §4.2 leading indicators).
 *
 * TWO ENGINES, ONE ARGUMENT.
 *
 * The first builds a PREDICTIVE index out of things a site can change this
 * week — overdue actions, the share of fixes that are only a briefing, how
 * often anybody writes down something good, whether inspections are failing,
 * whether the permits and RAMS on file are in date, whether device alarms get
 * answered. An index built from last quarter's accidents is not predictive; it
 * is a restatement. Every component states its basis and its inputs, and a
 * component that cannot be computed lowers the index's COVERAGE rather than
 * being quietly treated as good news.
 *
 * The second looks for the opposite failure: a register that is too QUIET.
 * Under-reporting is the single most corrosive failure in construction safety
 * data, because every rate the platform publishes divides by it and every
 * prequalification questionnaire relies on it. It is also the one thing a
 * site's own numbers cannot show, since the evidence is the absence of rows.
 * So this engine reasons from ratios that hold across the industry rather than
 * from absolute counts: a site recording injuries but no near misses, or one
 * recording nothing at all across hundreds of thousands of worked hours, or
 * one an order of magnitude quieter than its sibling projects. Each finding
 * carries what was expected, on what basis, and what would refute it.
 *
 * Nothing here decides anything. Both engines produce evidence for a human,
 * and the confidence attached to a finding is never 1.
 */

import type { SafetyRiskBand, SafetyRiskComponent } from "@constructos/shared";

const round2 = (n: number): number => Math.round(n * 100) / 100;
const clamp = (n: number, lo = 0, hi = 100): number => Math.min(hi, Math.max(lo, n));

/* ================================================================== */
/* The predictive index                                                */
/* ================================================================== */

export interface RiskIndexInput {
  projectId: string;
  from: string;
  to: string;
  asOf: string;
  /** corrective actions on the project */
  actions: {
    open: number;
    overdue: number;
    total: number;
    weakControl: number;
    ineffective: number;
  };
  observations: { positive: number; negative: number; total: number; highRisk: number };
  inspections: { completed: number; failed: number; criticalDefects: number };
  briefings: { talksDelivered: number; weeksInWindow: number; workersBriefed: number; workersOnSite: number };
  programme: { expired: number; expiringSoon: number; criticalExpired: number; active: number };
  incidents: {
    total: number;
    lostTime: number;
    recordableOrReportable: number;
    /** days since the most recent incident of any kind; null when there are none */
    daysSinceLast: number | null;
    investigationsOverdue: number;
  };
  statutory: { notificationsMissed: number; notificationsLate: number; outstandingDuties: number };
  devices: { alarms: number; unacknowledged: number; overdueAcknowledgement: number };
}

export interface RiskComponentResult {
  key: SafetyRiskComponent;
  name: string;
  /** 0-100 where 100 is the worst; null when it could not be computed */
  value: number | null;
  weight: number;
  contribution: number | null;
  basis: string;
  inputs: Record<string, number | null>;
  reasons: string[];
}

export interface RiskIndexResult {
  projectId: string;
  from: string;
  to: string;
  asOf: string;
  /** 0-100, higher = more exposed; null when coverage is too thin to publish */
  score: number | null;
  band: SafetyRiskBand;
  components: RiskComponentResult[];
  coverage: number;
  reasons: string[];
  /** the components doing the most damage, in order — what to act on */
  drivers: Array<{ key: SafetyRiskComponent; name: string; contribution: number; advice: string }>;
  explanation: string;
}

const COMPONENT_WEIGHTS: Record<SafetyRiskComponent, number> = {
  action_overdue_load: 18,
  weak_control_share: 12,
  observation_reporting: 12,
  inspection_failure_rate: 14,
  briefing_coverage: 10,
  programme_expiry: 14,
  incident_recency: 10,
  statutory_discipline: 6,
  device_alarm_load: 4,
};

const ADVICE: Record<SafetyRiskComponent, string> = {
  action_overdue_load:
    "Close or re-date the overdue actions. A hazard identified, owned and left is the worst " +
    "evidential position a site can be in.",
  weak_control_share:
    "Re-open the actions answered with a briefing or PPE and ask what an engineering control would " +
    "have been. A register of re-briefings will see the same event again.",
  observation_reporting:
    "Reporting has gone quiet or has gone entirely negative. Both are culture findings — ask the " +
    "supervisors what happened to the last report they made.",
  inspection_failure_rate:
    "Inspections are failing. Fix the standard on site rather than the inspection frequency.",
  briefing_coverage:
    "Fewer briefings are being delivered than the workforce and the window imply. Check who is " +
    "actually being briefed before the next high-risk activity starts.",
  programme_expiry:
    "Permits, RAMS or competency cards have expired. The activity they authorise is now " +
    "unauthorised — renew, supersede or stop the work.",
  incident_recency:
    "Something happened recently. The period after an event is when the same mechanism recurs; " +
    "verify the interim controls are actually in place.",
  statutory_discipline:
    "A statutory notification has been missed or made late. That is an offence in its own right, " +
    "separate from the accident.",
  device_alarm_load:
    "Device alarms are not being answered. A lone-worker alarm nobody acknowledges is a device that " +
    "is not protecting anybody.",
};

/**
 * Compute the index.
 *
 * Each component maps its inputs onto 0-100 RISK (100 = worst). The score is
 * the weighted mean of the components that could be computed, and `coverage`
 * says how much of the index's weight that was. Below 40% coverage the score
 * is withheld: an index carried by three of nine components is a number that
 * will be quoted without its caveat.
 */
export function computeRiskIndex(input: RiskIndexInput): RiskIndexResult {
  const components: RiskComponentResult[] = [];

  const push = (
    key: SafetyRiskComponent,
    name: string,
    value: number | null,
    basis: string,
    inputs: Record<string, number | null>,
    reasons: string[] = [],
  ): void => {
    components.push({
      key,
      name,
      value: value === null ? null : round2(clamp(value)),
      weight: COMPONENT_WEIGHTS[key],
      contribution:
        value === null ? null : round2(clamp(value) * (COMPONENT_WEIGHTS[key] / 100)),
      basis,
      inputs,
      reasons,
    });
  };

  /* 1. overdue action load — share of live actions that are overdue */
  const liveActions = input.actions.open;
  push(
    "action_overdue_load",
    "Overdue corrective actions",
    liveActions > 0 ? (input.actions.overdue / liveActions) * 100 : input.actions.overdue > 0 ? 100 : null,
    "The share of open corrective actions that are past their due date. Scaled against open " +
      "actions, not all actions, so a project that closes what it raises is not punished for raising things.",
    { open: liveActions, overdue: input.actions.overdue },
    liveActions === 0 && input.actions.overdue === 0
      ? ["No corrective action is open on this project, so there is no overdue load to measure."]
      : [],
  );

  /* 2. weak-control share */
  push(
    "weak_control_share",
    "Fixes that are only a briefing or PPE",
    input.actions.total >= 3 ? (input.actions.weakControl / input.actions.total) * 100 : null,
    "The share of corrective actions whose control sits at the administrative or PPE end of the " +
      "hierarchy. Above about half, a programme is managing paperwork rather than hazards.",
    { weakControl: input.actions.weakControl, total: input.actions.total },
    input.actions.total < 3
      ? [`${input.actions.total} corrective action(s) recorded — too few to read a hierarchy profile.`]
      : [],
  );

  /* 3. observation reporting — silence and negativity are both findings */
  const obsTotal = input.observations.total;
  let observationRisk: number | null = null;
  const observationReasons: string[] = [];
  if (obsTotal === 0) {
    observationRisk = 85;
    observationReasons.push(
      "No observation of any kind was recorded in the window. On a live site that is a reporting " +
        "finding, not a safety one.",
    );
  } else if (obsTotal < 5) {
    observationRisk = 60;
    observationReasons.push(
      `${obsTotal} observation(s) in the window — enough to know reporting exists, not enough to say ` +
        `it is working.`,
    );
  } else {
    const positiveShare = input.observations.positive / obsTotal;
    // 0% positive is the worst reporting culture signal; 30%+ is healthy.
    observationRisk = clamp((1 - positiveShare / 0.3) * 70);
  }
  push(
    "observation_reporting",
    "Observation reporting",
    observationRisk,
    "Volume first, then the positive share. A site that reports nothing and a site that only ever " +
      "reports faults have the same problem: the people who see things have stopped writing them down.",
    {
      total: obsTotal,
      positive: input.observations.positive,
      negative: input.observations.negative,
      highRisk: input.observations.highRisk,
    },
    observationReasons,
  );

  /* 4. inspection failure rate */
  push(
    "inspection_failure_rate",
    "Inspections failing",
    input.inspections.completed >= 3
      ? ((input.inspections.failed + input.inspections.criticalDefects * 0.5) /
          input.inspections.completed) *
        100
      : null,
    "Failed inspections, plus half-weight for critical defects found on otherwise-passing ones, " +
      "over completed inspections in the window.",
    {
      completed: input.inspections.completed,
      failed: input.inspections.failed,
      criticalDefects: input.inspections.criticalDefects,
    },
    input.inspections.completed < 3
      ? [
          `${input.inspections.completed} inspection(s) completed in the window — too few to read a ` +
            `failure rate. That is itself worth noticing on a live site.`,
        ]
      : [],
  );

  /* 5. briefing coverage */
  const weeks = Math.max(1, input.briefings.weeksInWindow);
  let briefingRisk: number | null = null;
  const briefingReasons: string[] = [];
  if (input.briefings.workersOnSite > 0) {
    const share = input.briefings.workersBriefed / input.briefings.workersOnSite;
    briefingRisk = clamp((1 - share) * 100);
  } else if (input.briefings.talksDelivered > 0 || weeks > 0) {
    const perWeek = input.briefings.talksDelivered / weeks;
    // one talk a week is the floor most sites commit to
    briefingRisk = clamp((1 - Math.min(1, perWeek)) * 80);
    briefingReasons.push(
      "No worker register covers this project, so coverage is read from the rate of talks delivered " +
        "rather than from the share of the workforce briefed.",
    );
  }
  push(
    "briefing_coverage",
    "Briefing coverage",
    briefingRisk,
    "The share of the registered workforce briefed in the window, falling back to talks per week " +
      "when no worker register exists.",
    {
      talksDelivered: input.briefings.talksDelivered,
      workersBriefed: input.briefings.workersBriefed,
      workersOnSite: input.briefings.workersOnSite,
      weeks,
    },
    briefingReasons,
  );

  /* 6. programme expiry */
  const programmeTotal = input.programme.active + input.programme.expired;
  let expiryRisk: number | null = null;
  if (programmeTotal > 0) {
    const base = (input.programme.expired / programmeTotal) * 100;
    // an expired permit or competency card is worth more than an expired policy
    expiryRisk = clamp(base + input.programme.criticalExpired * 15);
  }
  push(
    "programme_expiry",
    "Expired safety documents",
    expiryRisk,
    "Expired records over live ones, with an uplift for each expired permit-to-work, competency " +
      "card or temporary-works design — those authorise an activity rather than describe one.",
    {
      expired: input.programme.expired,
      criticalExpired: input.programme.criticalExpired,
      expiringSoon: input.programme.expiringSoon,
      active: input.programme.active,
    },
    programmeTotal === 0
      ? ["No safety programme record is held for this project, so nothing can be shown to be in date."]
      : [],
  );

  /* 7. incident recency */
  let recencyRisk: number | null = null;
  const recencyReasons: string[] = [];
  if (input.incidents.daysSinceLast === null) {
    recencyReasons.push("No incident is recorded on this project, so there is no recency to measure.");
  } else {
    // 0 days = 100, 90 days or more = 0
    recencyRisk = clamp(((90 - Math.min(90, input.incidents.daysSinceLast)) / 90) * 100);
    if (input.incidents.lostTime > 0) recencyRisk = clamp(recencyRisk + 10);
  }
  push(
    "incident_recency",
    "Recency of the last incident",
    recencyRisk,
    "How recently something happened, decaying to nothing at ninety days, with an uplift where a " +
      "lost-time case is in the window. The period after an event is when the same mechanism recurs.",
    {
      daysSinceLast: input.incidents.daysSinceLast,
      total: input.incidents.total,
      lostTime: input.incidents.lostTime,
      investigationsOverdue: input.incidents.investigationsOverdue,
    },
    recencyReasons,
  );

  /* 8. statutory discipline */
  const statutoryEvents =
    input.statutory.notificationsMissed +
    input.statutory.notificationsLate +
    input.statutory.outstandingDuties;
  push(
    "statutory_discipline",
    "Statutory notification discipline",
    input.incidents.recordableOrReportable > 0 || statutoryEvents > 0
      ? clamp(
          input.statutory.notificationsMissed * 60 +
            input.statutory.notificationsLate * 30 +
            input.statutory.outstandingDuties * 15 +
            input.incidents.investigationsOverdue * 10,
        )
      : null,
    "Missed and late statutory notifications, live undischarged duties, and overdue investigations. " +
      "Each is independently actionable by a regulator whatever the investigation concludes.",
    {
      missed: input.statutory.notificationsMissed,
      late: input.statutory.notificationsLate,
      outstanding: input.statutory.outstandingDuties,
      investigationsOverdue: input.incidents.investigationsOverdue,
    },
    input.incidents.recordableOrReportable === 0 && statutoryEvents === 0
      ? ["No reportable incident and no live statutory duty on this project in the window."]
      : [],
  );

  /* 9. device alarm load */
  push(
    "device_alarm_load",
    "Unanswered device alarms",
    input.devices.alarms > 0
      ? (input.devices.unacknowledged / input.devices.alarms) * 100
      : null,
    "The share of wearable and lone-worker alarms nobody acknowledged. A device whose alarm goes " +
      "unanswered is not protecting the person wearing it.",
    {
      alarms: input.devices.alarms,
      unacknowledged: input.devices.unacknowledged,
      overdue: input.devices.overdueAcknowledgement,
    },
    input.devices.alarms === 0
      ? ["No wearable or lone-worker device has reported on this project."]
      : [],
  );

  const computed = components.filter((c) => c.value !== null);
  const totalWeight = components.reduce((s, c) => s + c.weight, 0);
  const availableWeight = computed.reduce((s, c) => s + c.weight, 0);
  const coverage = totalWeight > 0 ? round2(availableWeight / totalWeight) : 0;

  const reasons: string[] = [];
  let score: number | null = null;
  let band: SafetyRiskBand = "unrated";
  if (coverage >= 0.4) {
    score = round2(computed.reduce((s, c) => s + c.value! * c.weight, 0) / availableWeight);
    band = score >= 75 ? "severe" : score >= 50 ? "high" : score >= 25 ? "elevated" : "low";
  } else {
    reasons.push(
      `Only ${Math.round(coverage * 100)}% of the index's weight could be computed from the records ` +
        `held, so no score is published. The components that were computed are shown; the ones that ` +
        `were not name what is missing.`,
    );
  }
  for (const c of components) {
    if (c.value === null) reasons.push(...c.reasons);
  }

  const drivers = computed
    .filter((c) => (c.contribution ?? 0) > 0)
    .sort((a, b) => (b.contribution ?? 0) - (a.contribution ?? 0))
    .slice(0, 3)
    .map((c) => ({
      key: c.key,
      name: c.name,
      contribution: c.contribution!,
      advice: ADVICE[c.key],
    }));

  return {
    projectId: input.projectId,
    from: input.from,
    to: input.to,
    asOf: input.asOf,
    score,
    band,
    components,
    coverage,
    reasons,
    drivers,
    explanation:
      score === null
        ? "The index is unrated: too little of it could be computed from the records this project holds."
        : `The index reads ${score} (${band}) on ${Math.round(coverage * 100)}% coverage. It is built ` +
          `from leading indicators only — what is overdue, what is expiring, what is being reported ` +
          `and how strong the fixes are — so it moves before the accident does, and it can be moved ` +
          `back the same way. The three components carrying the most of it are named as drivers.`,
  };
}

/* ================================================================== */
/* Under-reporting detection (Vol II M #701–702)                       */
/* ================================================================== */

/**
 * The near-miss-to-injury floor. Bird's 1969 study of 1.75m reported events
 * gives roughly 600 near misses to 30 property-damage events to 10 minor
 * injuries to 1 serious injury. The ratio is not a law of nature and modern
 * work disputes the exact shape, but its DIRECTION is not in dispute: injuries
 * are the rarest layer, and a site that records injuries and no near misses at
 * all is not experiencing fewer close calls than everybody else — it is not
 * writing them down. The floor used here (one near miss per injury) is an
 * order of magnitude more forgiving than any published ratio, so a breach of
 * it is very hard to explain innocently.
 */
export const NEAR_MISS_FLOOR_PER_INJURY = 1;

/**
 * Hours of exposure beyond which a total absence of events becomes evidence
 * rather than luck. 200,000 hours is 100 people for a year — the OSHA rate
 * basis, chosen because it is the point at which industry rates predict at
 * least one recordable case on any published construction rate.
 */
export const SILENCE_THRESHOLD_HOURS = 200_000;

export interface UnderReportingInput {
  projectId: string;
  projectName: string;
  from: string;
  to: string;
  exposureHours: number | null;
  exposureSource: string | null;
  counts: {
    incidents: number;
    injuries: number;
    nearMisses: number;
    observations: number;
    fatalities: number;
    lostTime: number;
  };
  /** the same figures for the company's other projects, for a peer read */
  peers: Array<{ projectId: string; incidents: number; exposureHours: number | null }>;
}

export interface UnderReportingFinding {
  key: string;
  title: string;
  /** 0-1 — never 1: this is evidence for a human, not a determination */
  confidence: number;
  severity: "critical" | "high" | "medium" | "low";
  expected: string;
  observed: string;
  explanation: string;
  refutedBy: string;
  inputs: Record<string, number | string | null>;
}

export interface UnderReportingResult {
  projectId: string;
  from: string;
  to: string;
  findings: UnderReportingFinding[];
  reasons: string[];
}

/**
 * Look for silence. Every finding states what was expected, on what basis,
 * what was observed, and — the field that matters most — what would refute it,
 * because the honest answer to most of these is "the site really was that
 * quiet" and the register should say so.
 */
export function assessUnderReporting(input: UnderReportingInput): UnderReportingResult {
  const findings: UnderReportingFinding[] = [];
  const reasons: string[] = [];
  const { counts } = input;

  /* 1. injuries recorded, near misses not */
  if (counts.injuries > 0 && counts.nearMisses < counts.injuries * NEAR_MISS_FLOOR_PER_INJURY) {
    findings.push({
      key: "near_miss_floor",
      title: "Injuries are being recorded and near misses are not",
      confidence: counts.injuries >= 3 ? 0.75 : 0.55,
      severity: counts.injuries >= 3 ? "high" : "medium",
      expected:
        `At least ${counts.injuries * NEAR_MISS_FLOOR_PER_INJURY} near miss(es) alongside ` +
        `${counts.injuries} injury/injuries — and that floor is an order of magnitude below any ` +
        `published incident-pyramid ratio.`,
      observed: `${counts.nearMisses} near miss(es) recorded in the window.`,
      explanation:
        "A site experiences close calls far more often than it experiences injuries; every study of " +
        "the incident pyramid since Bird (1969) agrees on the direction even where it disputes the " +
        "numbers. A register showing injuries but no near misses is therefore evidence about the " +
        "REPORTING, not about the site: the events happened and nobody wrote them down. That matters " +
        "beyond culture — near misses are the only free data a safety programme gets, and a " +
        "programme without them is managing outcomes it can no longer see coming.",
      refutedBy:
        "Near misses being captured somewhere else (a paper book, a subcontractor's own system) and " +
        "never entered here, or a window too short to carry the ratio.",
      inputs: {
        injuries: counts.injuries,
        nearMisses: counts.nearMisses,
        observations: counts.observations,
        from: input.from,
        to: input.to,
      },
    });
  }

  /* 2. substantial exposure, complete silence */
  if (
    input.exposureHours != null &&
    input.exposureHours >= SILENCE_THRESHOLD_HOURS &&
    counts.incidents === 0
  ) {
    findings.push({
      key: "silent_register",
      title: "No event of any kind recorded across a substantial exposure",
      confidence: 0.7,
      severity: "high",
      expected:
        `At least one recordable event across ${Math.round(input.exposureHours).toLocaleString()} ` +
        `worked hours. Every published construction incident rate predicts one well before this point.`,
      observed: "No incident, injury or near miss is recorded in the window.",
      explanation:
        "Two hundred thousand hours is a hundred people for a year. A site of that size with a " +
        "genuinely empty incident register would be an outlier worth studying; the far more common " +
        "explanation is that events are being handled verbally and never entered. The distinction " +
        "matters because every rate this platform publishes — and every rate a client's " +
        "prequalification team reads — divides by this register.",
      refutedBy:
        "Events recorded in a subcontractor's system and never transferred, or a project whose " +
        "hours are being attributed here but worked elsewhere.",
      inputs: {
        exposureHours: input.exposureHours,
        exposureSource: input.exposureSource,
        observations: counts.observations,
      },
    });
  }

  /* 3. peer comparison within the company */
  const peers = input.peers.filter(
    (p) => p.projectId !== input.projectId && p.exposureHours != null && p.exposureHours > 0,
  );
  if (peers.length >= 2 && input.exposureHours != null && input.exposureHours > 0) {
    const peerRates = peers
      .map((p) => (p.incidents * 200_000) / p.exposureHours!)
      .sort((a, b) => a - b);
    const median = peerRates[Math.floor(peerRates.length / 2)] ?? 0;
    const ourRate = (counts.incidents * 200_000) / input.exposureHours;
    if (median > 0 && ourRate < median * 0.2) {
      findings.push({
        key: "peer_divergence",
        title: "An order of magnitude quieter than sibling projects",
        confidence: peers.length >= 4 ? 0.6 : 0.45,
        severity: "medium",
        expected:
          `Something within an order of magnitude of the company's median of ` +
          `${round2(median)} incidents per 200,000 hours across ${peers.length} comparable projects.`,
        observed: `${round2(ourRate)} incidents per 200,000 hours on this project.`,
        explanation:
          "Projects inside one company share procedures, training and reporting expectations, which " +
          "makes them the fairest comparator available — far fairer than a national rate computed " +
          "over a different mix of work. A project five times quieter than its siblings is either " +
          "doing something the others should copy or is not reporting; both are worth an hour of " +
          "somebody's time, and only one of them is good news.",
        refutedBy:
          "A genuinely different work mix (fit-out against groundworks), a much smaller or newer " +
          "project, or hours attributed differently between the projects being compared.",
        inputs: {
          ourRate: round2(ourRate),
          peerMedian: round2(median),
          peerProjects: peers.length,
          incidents: counts.incidents,
          exposureHours: input.exposureHours,
        },
      });
    }
  } else if (input.exposureHours == null) {
    reasons.push(
      "No exposure hours are held for this window, so neither the silence test nor the peer " +
        "comparison could run. Only the near-miss ratio, which needs no denominator, was assessed.",
    );
  } else if (peers.length < 2) {
    reasons.push(
      "Fewer than two sibling projects hold exposure hours, so no peer comparison was made. A peer " +
        "read against one project is an anecdote.",
    );
  }

  return { projectId: input.projectId, from: input.from, to: input.to, findings, reasons };
}
