/**
 * Critical Path Method engine (pure — no I/O, fully unit-testable).
 *
 * Conventions:
 * - Time is measured in whole calendar days relative to `projectStart`.
 * - A task with duration d occupies [start, start + d) — the finish value is
 *   EXCLUSIVE, which keeps dependency math uniform (FS: succ.ES = pred.EF + lag).
 *   Reported `finishDate` is the inclusive last day (start + d - 1; = start for
 *   milestones with d = 0).
 * - Lags may be negative (leads). Dependency types: FS, SS, FF, SF.
 * - Constraints: start_no_earlier_than, must_start_on (pins both passes; can
 *   produce negative float — a real signal, not an error), finish_no_later_than
 *   (caps the late finish; produces negative float when breached).
 * - Actuals: actualStart pins ES; actualFinish pins EF (and overrides duration).
 * - Cycles abort the computation and are reported for the DCMA logic checks.
 */

import type { DependencyType, TaskConstraintType } from "@constructos/shared";

export interface CpmTaskInput {
  id: string;
  /** working duration in days; 0 = milestone */
  duration: number;
  constraintType?: TaskConstraintType | null;
  constraintDate?: string | null; // ISO date
  actualStart?: string | null;
  actualFinish?: string | null;
}

export interface CpmDependencyInput {
  predecessorId: string;
  successorId: string;
  type: DependencyType;
  lagDays: number;
}

export interface CpmTaskResult {
  id: string;
  earlyStart: number;
  earlyFinish: number;
  lateStart: number;
  lateFinish: number;
  totalFloat: number;
  isCritical: boolean;
  startDate: string;
  /** inclusive last day of work */
  finishDate: string;
}

export interface CpmResult {
  ok: boolean;
  /** task ids involved in a dependency cycle (empty when ok) */
  cycle: string[];
  tasks: Map<string, CpmTaskResult>;
  projectFinishDate: string | null;
  projectDurationDays: number;
  criticalIds: string[];
}

const DAY_MS = 86400000;

export function dayFromIso(iso: string, projectStart: string): number {
  return Math.round((Date.parse(iso + "T00:00:00Z") - Date.parse(projectStart + "T00:00:00Z")) / DAY_MS);
}

export function isoFromDay(day: number, projectStart: string): string {
  return new Date(Date.parse(projectStart + "T00:00:00Z") + day * DAY_MS).toISOString().slice(0, 10);
}

export function computeCpm(
  taskInputs: CpmTaskInput[],
  deps: CpmDependencyInput[],
  options: { projectStart: string },
): CpmResult {
  const start = options.projectStart;
  const ids = new Set(taskInputs.map((t) => t.id));
  const validDeps = deps.filter((d) => ids.has(d.predecessorId) && ids.has(d.successorId));

  // Effective duration / pinned days from actuals.
  const dur = new Map<string, number>();
  const pinStart = new Map<string, number>();
  const pinFinish = new Map<string, number>();
  for (const t of taskInputs) {
    let d = Math.max(0, Math.round(t.duration));
    const aS = t.actualStart ? dayFromIso(t.actualStart, start) : null;
    const aF = t.actualFinish ? dayFromIso(t.actualFinish, start) : null;
    if (aS !== null) pinStart.set(t.id, aS);
    if (aF !== null) {
      // exclusive finish = inclusive actual finish + 1 (milestone stays equal)
      const exclusive = d === 0 && aS !== null && aF === aS ? aF : aF + 1;
      pinFinish.set(t.id, exclusive);
      if (aS !== null) d = Math.max(0, exclusive - aS);
    }
    dur.set(t.id, d);
  }

  // Kahn topological sort over successor edges.
  const outgoing = new Map<string, CpmDependencyInput[]>();
  const incoming = new Map<string, CpmDependencyInput[]>();
  const indegree = new Map<string, number>();
  for (const t of taskInputs) indegree.set(t.id, 0);
  for (const d of validDeps) {
    (outgoing.get(d.predecessorId) ?? outgoing.set(d.predecessorId, []).get(d.predecessorId)!).push(d);
    (incoming.get(d.successorId) ?? incoming.set(d.successorId, []).get(d.successorId)!).push(d);
    indegree.set(d.successorId, (indegree.get(d.successorId) ?? 0) + 1);
  }
  const queue = taskInputs.filter((t) => (indegree.get(t.id) ?? 0) === 0).map((t) => t.id);
  const topo: string[] = [];
  const indegreeWork = new Map(indegree);
  while (queue.length > 0) {
    const id = queue.shift()!;
    topo.push(id);
    for (const d of outgoing.get(id) ?? []) {
      const n = (indegreeWork.get(d.successorId) ?? 0) - 1;
      indegreeWork.set(d.successorId, n);
      if (n === 0) queue.push(d.successorId);
    }
  }
  if (topo.length !== taskInputs.length) {
    const cycle = taskInputs.map((t) => t.id).filter((id) => !topo.includes(id));
    return {
      ok: false,
      cycle,
      tasks: new Map(),
      projectFinishDate: null,
      projectDurationDays: 0,
      criticalIds: [],
    };
  }

  const byId = new Map(taskInputs.map((t) => [t.id, t]));
  const ES = new Map<string, number>();
  const EF = new Map<string, number>();

  // Forward pass.
  for (const id of topo) {
    const t = byId.get(id)!;
    const d = dur.get(id)!;
    let es = 0;
    for (const dep of incoming.get(id) ?? []) {
      const pES = ES.get(dep.predecessorId)!;
      const pEF = EF.get(dep.predecessorId)!;
      let bound: number;
      switch (dep.type) {
        case "FS": bound = pEF + dep.lagDays; break;
        case "SS": bound = pES + dep.lagDays; break;
        case "FF": bound = pEF + dep.lagDays - d; break;
        case "SF": bound = pES + dep.lagDays - d; break;
      }
      es = Math.max(es, bound);
    }
    if (t.constraintType === "start_no_earlier_than" && t.constraintDate) {
      es = Math.max(es, dayFromIso(t.constraintDate, start));
    }
    if (t.constraintType === "must_start_on" && t.constraintDate) {
      es = dayFromIso(t.constraintDate, start);
    }
    const pinnedS = pinStart.get(id);
    if (pinnedS !== undefined) es = pinnedS;
    let ef = es + d;
    const pinnedF = pinFinish.get(id);
    if (pinnedF !== undefined) ef = pinnedF;
    ES.set(id, es);
    EF.set(id, ef);
  }

  const projectFinish = Math.max(0, ...topo.map((id) => EF.get(id)!));

  // Backward pass.
  const LS = new Map<string, number>();
  const LF = new Map<string, number>();
  for (const id of [...topo].reverse()) {
    const t = byId.get(id)!;
    const d = dur.get(id)!;
    let lf = projectFinish;
    for (const dep of outgoing.get(id) ?? []) {
      const sLS = LS.get(dep.successorId)!;
      const sLF = LF.get(dep.successorId)!;
      let bound: number;
      switch (dep.type) {
        case "FS": bound = sLS - dep.lagDays; break;
        case "SS": bound = sLS - dep.lagDays + d; break;
        case "FF": bound = sLF - dep.lagDays; break;
        case "SF": bound = sLF - dep.lagDays + d; break;
      }
      lf = Math.min(lf, bound);
    }
    if (t.constraintType === "finish_no_later_than" && t.constraintDate) {
      // constraintDate is the inclusive latest finish day
      lf = Math.min(lf, dayFromIso(t.constraintDate, start) + (d === 0 ? 0 : 1));
    }
    let ls = lf - d;
    if (t.constraintType === "must_start_on" && t.constraintDate) {
      ls = dayFromIso(t.constraintDate, start);
      lf = ls + d;
    }
    LS.set(id, ls);
    LF.set(id, lf);
  }

  const tasks = new Map<string, CpmTaskResult>();
  const criticalIds: string[] = [];
  for (const id of topo) {
    const es = ES.get(id)!;
    const ef = EF.get(id)!;
    const ls = LS.get(id)!;
    const lf = LF.get(id)!;
    const d = dur.get(id)!;
    const totalFloat = ls - es;
    const isCritical = totalFloat <= 0;
    if (isCritical) criticalIds.push(id);
    tasks.set(id, {
      id,
      earlyStart: es,
      earlyFinish: ef,
      lateStart: ls,
      lateFinish: lf,
      totalFloat,
      isCritical,
      startDate: isoFromDay(es, start),
      finishDate: isoFromDay(d === 0 ? es : es + d - 1, start),
    });
  }

  return {
    ok: true,
    cycle: [],
    tasks,
    projectFinishDate: isoFromDay(Math.max(0, projectFinish - 1), start),
    projectDurationDays: projectFinish,
    criticalIds,
  };
}
