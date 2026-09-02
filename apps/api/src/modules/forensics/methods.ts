/**
 * Forensic delay-analysis method suite (spec Vol II Domain D #270-277) — pure.
 *
 * Four methods, each mapped to its AACE 29R-03 Method Implementation Protocol
 * and to the SCL Delay & Disruption Protocol section a tribunal will ask about:
 *
 *  IMPACTED AS-PLANNED (MIP 3.6, additive/prospective). Insert every selected
 *  event's fragnet into the AS-PLANNED network in date order and report the
 *  incremental completion shift each one causes. Cumulative, because the
 *  second event's impact depends on where the first one left the network —
 *  reporting each event against the untouched baseline double-counts.
 *
 *  COLLAPSED AS-BUILT / but-for (MIP 3.8, subtractive/retrospective). Take the
 *  AS-BUILT network and remove the delay attributable to a chosen party, then
 *  recompute: the difference is what the works would have finished but for
 *  that party's delay.
 *
 *  WINDOWS / TIME-SLICE (MIP 3.3-3.4, observational/retrospective). Between
 *  two consecutive updates, measure the movement of the completion date and
 *  attribute it to the events whose struck activity lies on the window's
 *  critical path. Events off the critical path in that window are reported as
 *  non-driving rather than quietly dropped.
 *
 *  RETROSPECTIVE LONGEST PATH (MIP 3.9). The as-built driving chain.
 *
 * Every function is deterministic, takes a network in and gives a result out,
 * and NEVER invents a number: an event whose struck activity is missing from
 * the network is reported in `skipped` with the reason.
 */

import {
  computeCpm2,
  type CalendarSpec,
  type Cpm2DependencyInput,
  type Cpm2Result,
  type Cpm2TaskInput,
} from "../schedule/cpm2.js";

export interface ForensicNetwork {
  tasks: Cpm2TaskInput[];
  deps: Cpm2DependencyInput[];
  projectStart: string;
  dataDate?: string | null;
  calendars?: CalendarSpec[];
  defaultCalendarId?: string | null;
}

export interface ForensicEvent {
  id: string;
  number?: number;
  title: string;
  startDate: string;
  durationDays: number;
  /** the activity the delay strikes; the fragnet is inserted after it */
  struckTaskId: string | null;
  party?: string;
  excusable?: boolean;
  compensable?: boolean;
}

export interface SkippedEvent {
  eventId: string;
  title: string;
  reason: string;
}

const FRAGNET_PREFIX = "__fragnet:";

function fragnetId(eventId: string): string {
  return `${FRAGNET_PREFIX}${eventId}`;
}

function run(network: ForensicNetwork, tasks: Cpm2TaskInput[], deps: Cpm2DependencyInput[]): Cpm2Result {
  return computeCpm2(tasks, deps, {
    projectStart: network.projectStart,
    dataDate: network.dataDate ?? null,
    calendars: network.calendars,
    defaultCalendarId: network.defaultCalendarId ?? null,
  });
}

/**
 * Insert an event as a fragnet: struck --FS--> fragnet --FS--> (every
 * successor of the struck activity). The fragnet carries a
 * start_no_earlier_than on the event's own start date so a delay that begins
 * after the struck activity finishes still pushes from when it really began.
 */
export function insertFragnet(
  tasks: Cpm2TaskInput[],
  deps: Cpm2DependencyInput[],
  event: ForensicEvent,
): { tasks: Cpm2TaskInput[]; deps: Cpm2DependencyInput[] } {
  const struck = event.struckTaskId!;
  const id = fragnetId(event.id);
  const fragnet: Cpm2TaskInput = {
    id,
    duration: event.durationDays,
    constraintType: "start_no_earlier_than",
    constraintDate: event.startDate,
  };
  // Successors of the struck activity — but never another fragnet. Chaining
  // fragnets would make two delays over the SAME period add up sequentially
  // instead of overlapping, which is precisely the error that turns genuine
  // concurrency into a double-counted claim.
  const successors = new Set<string>();
  for (const d of deps) {
    if (d.predecessorId !== struck) continue;
    if (d.successorId === struck) continue;
    if (d.successorId.startsWith(FRAGNET_PREFIX)) continue;
    successors.add(d.successorId);
  }
  return {
    tasks: [...tasks, fragnet],
    deps: [
      ...deps,
      { predecessorId: struck, successorId: id, type: "FS", lagDays: 0 },
      ...[...successors].map(
        (successorId): Cpm2DependencyInput => ({
          predecessorId: id,
          successorId,
          type: "FS",
          lagDays: 0,
        }),
      ),
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Impacted as-planned (MIP 3.6)                                       */
/* ------------------------------------------------------------------ */

export interface IapStep {
  eventId: string;
  title: string;
  startDate: string;
  durationDays: number;
  /** movement caused by THIS event given everything inserted before it */
  incrementalDays: number;
  cumulativeDays: number;
  finishAfter: string | null;
  driving: boolean;
}

export interface IapResult {
  ok: true;
  method: "impacted_as_planned";
  mipCode: "3.6";
  sclReference: "SCL Protocol Part B §11 (impacted as-planned)";
  baselineFinish: string | null;
  baselineDurationDays: number;
  impactedFinish: string | null;
  totalDays: number;
  steps: IapStep[];
  skipped: SkippedEvent[];
}

export type MethodFailure = { ok: false; reason: string; cycle?: string[] };

export function impactedAsPlanned(
  network: ForensicNetwork,
  events: ForensicEvent[],
): IapResult | MethodFailure {
  const base = run(network, network.tasks, network.deps);
  if (!base.ok) return { ok: false, reason: "The as-planned network contains a dependency cycle", cycle: base.cycle };

  const known = new Set(network.tasks.map((t) => t.id));
  const skipped: SkippedEvent[] = [];
  const usable = events
    .filter((e) => {
      if (!e.struckTaskId) {
        skipped.push({ eventId: e.id, title: e.title, reason: "the event does not name a struck activity" });
        return false;
      }
      if (!known.has(e.struckTaskId)) {
        skipped.push({ eventId: e.id, title: e.title, reason: "the struck activity is not in this network" });
        return false;
      }
      if (e.durationDays <= 0) {
        skipped.push({ eventId: e.id, title: e.title, reason: "the event has no duration" });
        return false;
      }
      return true;
    })
    .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.id.localeCompare(b.id));

  let tasks = network.tasks;
  let deps = network.deps;
  let previousDuration = base.projectDurationDays;
  const steps: IapStep[] = [];
  for (const e of usable) {
    const next = insertFragnet(tasks, deps, e);
    const result = run(network, next.tasks, next.deps);
    if (!result.ok) {
      skipped.push({ eventId: e.id, title: e.title, reason: "inserting the fragnet created a cycle" });
      continue;
    }
    tasks = next.tasks;
    deps = next.deps;
    const incremental = result.projectDurationDays - previousDuration;
    previousDuration = result.projectDurationDays;
    steps.push({
      eventId: e.id,
      title: e.title,
      startDate: e.startDate,
      durationDays: e.durationDays,
      incrementalDays: incremental,
      cumulativeDays: result.projectDurationDays - base.projectDurationDays,
      finishAfter: result.projectFinishDate,
      driving: result.longestPath.includes(fragnetId(e.id)),
    });
  }

  const final = run(network, tasks, deps);
  return {
    ok: true,
    method: "impacted_as_planned",
    mipCode: "3.6",
    sclReference: "SCL Protocol Part B §11 (impacted as-planned)",
    baselineFinish: base.projectFinishDate,
    baselineDurationDays: base.projectDurationDays,
    impactedFinish: final.ok ? final.projectFinishDate : base.projectFinishDate,
    totalDays: final.ok ? final.projectDurationDays - base.projectDurationDays : 0,
    steps,
    skipped,
  };
}

/* ------------------------------------------------------------------ */
/* Collapsed as-built / but-for (MIP 3.8)                              */
/* ------------------------------------------------------------------ */

export interface CollapsedStep {
  eventId: string;
  title: string;
  party: string;
  struckTaskId: string;
  removedDays: number;
}

export interface CollapsedResult {
  ok: true;
  method: "collapsed_as_built";
  mipCode: "3.8";
  sclReference: "SCL Protocol Part B §11 (collapsed as-built / but-for)";
  party: string;
  asBuiltFinish: string | null;
  butForFinish: string | null;
  collapsedDays: number;
  removed: CollapsedStep[];
  skipped: SkippedEvent[];
}

/**
 * Remove the delay attributable to `party` from the as-built network.
 *
 * The as-built network carries actual dates, which pin every activity: a
 * but-for run must therefore release those pins on the activities being
 * collapsed and shorten them by the removed delay, then let the logic
 * reschedule. Activities NOT touched by the removed events keep their actual
 * dates, which is what stops the collapse from rewriting history wholesale.
 */
export function collapsedAsBuilt(
  network: ForensicNetwork,
  events: ForensicEvent[],
  party: string,
): CollapsedResult | MethodFailure {
  const asBuilt = run(network, network.tasks, network.deps);
  if (!asBuilt.ok) return { ok: false, reason: "The as-built network contains a dependency cycle", cycle: asBuilt.cycle };

  const byId = new Map(network.tasks.map((t) => [t.id, t] as const));
  const skipped: SkippedEvent[] = [];
  const removals = new Map<string, number>();
  const removed: CollapsedStep[] = [];
  for (const e of events) {
    if ((e.party ?? "neither") !== party) continue;
    if (!e.struckTaskId || !byId.has(e.struckTaskId)) {
      skipped.push({
        eventId: e.id,
        title: e.title,
        reason: e.struckTaskId ? "the struck activity is not in this network" : "the event does not name a struck activity",
      });
      continue;
    }
    if (e.durationDays <= 0) {
      skipped.push({ eventId: e.id, title: e.title, reason: "the event has no duration" });
      continue;
    }
    removals.set(e.struckTaskId, (removals.get(e.struckTaskId) ?? 0) + e.durationDays);
    removed.push({
      eventId: e.id,
      title: e.title,
      party,
      struckTaskId: e.struckTaskId,
      removedDays: e.durationDays,
    });
  }

  if (removals.size === 0) {
    return {
      ok: true,
      method: "collapsed_as_built",
      mipCode: "3.8",
      sclReference: "SCL Protocol Part B §11 (collapsed as-built / but-for)",
      party,
      asBuiltFinish: asBuilt.projectFinishDate,
      butForFinish: asBuilt.projectFinishDate,
      collapsedDays: 0,
      removed,
      skipped,
    };
  }

  const collapsedTasks: Cpm2TaskInput[] = network.tasks.map((t) => {
    const cut = removals.get(t.id);
    if (cut === undefined) return t;
    return {
      ...t,
      duration: Math.max(0, t.duration - cut),
      remainingDuration: null,
      percentComplete: null,
      // Release the pins: an activity that never suffered the delay would not
      // have started or finished when the record says it did.
      actualStart: null,
      actualFinish: null,
    };
  });
  const butFor = computeCpm2(collapsedTasks, network.deps, {
    projectStart: network.projectStart,
    // The but-for world has no data date: nothing is "already actual" in it.
    dataDate: null,
    calendars: network.calendars,
    defaultCalendarId: network.defaultCalendarId ?? null,
  });
  if (!butFor.ok) {
    return { ok: false, reason: "The collapsed network contains a dependency cycle", cycle: butFor.cycle };
  }

  return {
    ok: true,
    method: "collapsed_as_built",
    mipCode: "3.8",
    sclReference: "SCL Protocol Part B §11 (collapsed as-built / but-for)",
    party,
    asBuiltFinish: asBuilt.projectFinishDate,
    butForFinish: butFor.projectFinishDate,
    collapsedDays: asBuilt.projectDurationDays - butFor.projectDurationDays,
    removed,
    skipped,
  };
}

/* ------------------------------------------------------------------ */
/* Windows / time-slice (MIP 3.3-3.4)                                  */
/* ------------------------------------------------------------------ */

export interface WindowInput {
  start: string;
  /** null = the open-ended final window */
  end: string | null;
  /** network as at the window start (the nearest revision/baseline) */
  startNetwork: ForensicNetwork;
  startSourceId: string | null;
  startSourceName: string | null;
  /** network as at the window end */
  endNetwork: ForensicNetwork;
  endSourceId: string | null;
  endSourceName: string | null;
}

export interface WindowEventAttribution {
  eventId: string;
  number?: number;
  title: string;
  party: string;
  excusable: boolean;
  compensable: boolean;
  durationDays: number;
  startDate: string;
  /** the event's struck activity sits on the window's critical path */
  driving: boolean;
  /** movement this event alone causes in the window-start network */
  tiaDeltaDays: number | null;
  reason?: string;
}

export interface WindowResult {
  start: string;
  end: string | null;
  startFinish: string | null;
  endFinish: string | null;
  movementDays: number | null;
  startSourceId: string | null;
  startSourceName: string | null;
  endSourceId: string | null;
  endSourceName: string | null;
  criticalPath: string[];
  events: WindowEventAttribution[];
  drivingEvents: number;
  attributedDays: number;
  unattributedDays: number | null;
}

/**
 * Per-window CPM: the completion date at the window's start and end, the
 * movement between them, and which events drove it.
 *
 * An event is "driving" when its struck activity lies on the critical path of
 * the window-start network — a delay to an activity with float did not move
 * completion, however large it was, and saying otherwise is the commonest way
 * a delay claim falls apart.
 */
export function windowsAnalysis(
  windows: WindowInput[],
  events: ForensicEvent[],
): { ok: true; method: "windows"; mipCode: "3.4"; sclReference: string; windows: WindowResult[] } | MethodFailure {
  const out: WindowResult[] = [];
  for (const w of windows) {
    const startRun = run(w.startNetwork, w.startNetwork.tasks, w.startNetwork.deps);
    const endRun = run(w.endNetwork, w.endNetwork.tasks, w.endNetwork.deps);
    if (!startRun.ok) {
      return { ok: false, reason: `The network at ${w.start} contains a dependency cycle`, cycle: startRun.cycle };
    }
    if (!endRun.ok) {
      return { ok: false, reason: `The network at ${w.end ?? "the data date"} contains a dependency cycle`, cycle: endRun.cycle };
    }
    const criticalSet = new Set(startRun.criticalIds);
    const inWindow = events.filter(
      (e) => e.startDate >= w.start && (w.end === null || e.startDate < w.end),
    );
    const attributions: WindowEventAttribution[] = [];
    for (const e of inWindow) {
      let driving = false;
      let tiaDelta: number | null = null;
      let reason: string | undefined;
      if (!e.struckTaskId) {
        reason = "the event does not name a struck activity, so its effect on completion cannot be computed";
      } else if (!w.startNetwork.tasks.some((t) => t.id === e.struckTaskId)) {
        reason = "the struck activity is not in the network for this window";
      } else {
        driving = criticalSet.has(e.struckTaskId);
        const impacted = insertFragnet(w.startNetwork.tasks, w.startNetwork.deps, e);
        const impactedRun = run(w.startNetwork, impacted.tasks, impacted.deps);
        if (impactedRun.ok) tiaDelta = impactedRun.projectDurationDays - startRun.projectDurationDays;
        else reason = "inserting the fragnet created a cycle";
      }
      attributions.push({
        eventId: e.id,
        ...(e.number !== undefined ? { number: e.number } : {}),
        title: e.title,
        party: e.party ?? "neither",
        excusable: e.excusable ?? false,
        compensable: e.compensable ?? false,
        durationDays: e.durationDays,
        startDate: e.startDate,
        driving,
        tiaDeltaDays: tiaDelta,
        ...(reason ? { reason } : {}),
      });
    }
    const movement =
      startRun.projectFinishDate && endRun.projectFinishDate
        ? Math.round(
            (Date.parse(`${endRun.projectFinishDate}T00:00:00Z`) -
              Date.parse(`${startRun.projectFinishDate}T00:00:00Z`)) /
              86_400_000,
          )
        : null;
    const attributed = attributions
      .filter((a) => a.driving && a.tiaDeltaDays !== null)
      .reduce((sum, a) => sum + (a.tiaDeltaDays ?? 0), 0);
    out.push({
      start: w.start,
      end: w.end,
      startFinish: startRun.projectFinishDate,
      endFinish: endRun.projectFinishDate,
      movementDays: movement,
      startSourceId: w.startSourceId,
      startSourceName: w.startSourceName,
      endSourceId: w.endSourceId,
      endSourceName: w.endSourceName,
      criticalPath: startRun.longestPath,
      events: attributions,
      drivingEvents: attributions.filter((a) => a.driving).length,
      attributedDays: attributed,
      unattributedDays: movement === null ? null : movement - attributed,
    });
  }
  return {
    ok: true,
    method: "windows",
    mipCode: "3.4",
    sclReference: "SCL Protocol Part B §11 (time slice / windows analysis)",
    windows: out,
  };
}

/* ------------------------------------------------------------------ */
/* Retrospective longest path (MIP 3.9)                                */
/* ------------------------------------------------------------------ */

export interface LongestPathNode {
  taskId: string;
  startDate: string;
  finishDate: string;
  totalFloat: number;
  complete: boolean;
}

export function retrospectiveLongestPath(
  network: ForensicNetwork,
): { ok: true; method: "longest_path"; mipCode: "3.9"; sclReference: string; path: LongestPathNode[]; finish: string | null } | MethodFailure {
  const result = run(network, network.tasks, network.deps);
  if (!result.ok) return { ok: false, reason: "The as-built network contains a dependency cycle", cycle: result.cycle };
  const path: LongestPathNode[] = [];
  for (const id of result.longestPath) {
    const t = result.tasks.get(id);
    if (!t) continue;
    path.push({
      taskId: id,
      startDate: t.startDate,
      finishDate: t.finishDate,
      totalFloat: t.totalFloat,
      complete: t.complete,
    });
  }
  return {
    ok: true,
    method: "longest_path",
    mipCode: "3.9",
    sclReference: "SCL Protocol Part B §11 (retrospective longest path)",
    path,
    finish: result.projectFinishDate,
  };
}

/* ------------------------------------------------------------------ */
/* AACE 29R-03 method selection                                        */
/* ------------------------------------------------------------------ */

export interface MethodSelectionFactors {
  perspective: "prospective" | "retrospective";
  /** are contemporaneous schedule updates available? */
  updatesAvailable: boolean;
  /** is a credible as-planned baseline available? */
  baselineAvailable: boolean;
  /** is the as-built record complete enough to rebuild the network? */
  asBuiltComplete: boolean;
  /** does the analysis have to address concurrency? */
  concurrencyInIssue: boolean;
}

export interface MethodRecommendation {
  method: string;
  mipCode: string;
  label: string;
  suitability: "recommended" | "possible" | "not_advised";
  rationale: string;
}

/**
 * The AACE 29R-03 selection factors, applied. This does NOT pick for the
 * analyst — it ranks the methods and says why, and the chosen method's
 * rationale is stored on the analysis record so the choice is defensible
 * later.
 */
export function recommendMethods(f: MethodSelectionFactors): MethodRecommendation[] {
  const out: MethodRecommendation[] = [];

  out.push({
    method: "impacted_as_planned",
    mipCode: "3.6",
    label: "Impacted as-planned",
    suitability: f.baselineAvailable
      ? f.perspective === "prospective"
        ? "recommended"
        : "possible"
      : "not_advised",
    rationale: !f.baselineAvailable
      ? "No credible as-planned baseline exists to impact."
      : f.perspective === "prospective"
        ? "Additive modelling of an event against the as-planned programme is the standard prospective approach."
        : "Usable retrospectively, but it ignores as-built performance and is routinely criticised for it.",
  });

  out.push({
    method: "time_impact_analysis",
    mipCode: "3.7",
    label: "Time impact analysis",
    suitability: f.updatesAvailable && f.baselineAvailable ? "recommended" : f.baselineAvailable ? "possible" : "not_advised",
    rationale: f.updatesAvailable
      ? "Contemporaneous updates exist, so each event can be impacted into the programme current at the time it arose."
      : "Without contemporaneous updates the impact has to be modelled against a stale network.",
  });

  out.push({
    method: "windows",
    mipCode: "3.4",
    label: "Windows / time-slice",
    suitability: f.updatesAvailable && f.perspective === "retrospective" ? "recommended" : f.updatesAvailable ? "possible" : "not_advised",
    rationale: f.updatesAvailable
      ? "Contemporaneous updates let completion movement be measured window by window and attributed to what was critical at the time — the SCL Protocol's preferred retrospective approach."
      : "Windows analysis needs contemporaneous updates to slice against.",
  });

  out.push({
    method: "collapsed_as_built",
    mipCode: "3.8",
    label: "Collapsed as-built (but-for)",
    suitability: f.asBuiltComplete && f.perspective === "retrospective" ? "recommended" : f.asBuiltComplete ? "possible" : "not_advised",
    rationale: f.asBuiltComplete
      ? "A complete as-built record supports removing one party's delay and recomputing the but-for completion."
      : "The as-built record is not complete enough to rebuild a defensible network to collapse.",
  });

  out.push({
    method: "longest_path",
    mipCode: "3.9",
    label: "Retrospective longest path",
    suitability: f.asBuiltComplete ? "possible" : "not_advised",
    rationale: f.asBuiltComplete
      ? "Identifies the as-built driving chain; useful as a cross-check rather than as a standalone entitlement analysis."
      : "Needs a complete as-built record.",
  });

  if (f.concurrencyInIssue) {
    out.push({
      method: "concurrency",
      mipCode: "3.4",
      label: "Concurrency & pacing assessment",
      suitability: f.updatesAvailable ? "recommended" : "possible",
      rationale:
        "Concurrency is in issue, so each overlapping event must be tested alone and together against the programme current at the time.",
    });
  }

  const rank = { recommended: 0, possible: 1, not_advised: 2 } as const;
  return out.sort((a, b) => rank[a.suitability] - rank[b.suitability]);
}
