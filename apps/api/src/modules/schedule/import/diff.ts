/**
 * Revision diffing (#357) — pure.
 *
 * An imported programme is only useful if you can see what moved. This
 * compares two task/logic sets and reports the five things a planner and a
 * delay analyst actually argue about: activities added or removed, durations
 * changed, dates moved, logic added/removed/retyped, and progress claimed.
 *
 * Matching: `externalId` when both sides carry one (the P6 task_id / MSP UID
 * survives a re-export), otherwise wbsCode + name, otherwise name. A match
 * key collision is reported rather than silently merged.
 */

export interface DiffTask {
  id: string;
  externalId?: string | null;
  name: string;
  wbsCode?: string | null;
  durationDays: number;
  startDate?: string | null;
  finishDate?: string | null;
  percentComplete?: number | null;
  isCritical?: boolean;
  totalFloat?: number | null;
}

export interface DiffDependency {
  predecessorId: string;
  successorId: string;
  depType: string;
  lagDays: number;
}

export interface TaskChange {
  key: string;
  name: string;
  fromId: string | null;
  toId: string | null;
}

export interface DurationChange extends TaskChange {
  fromDays: number;
  toDays: number;
  deltaDays: number;
}

export interface DateChange extends TaskChange {
  fromStart: string | null;
  toStart: string | null;
  fromFinish: string | null;
  toFinish: string | null;
  startDeltaDays: number | null;
  finishDeltaDays: number | null;
}

export interface LogicChange {
  predecessor: string;
  successor: string;
  fromType?: string;
  toType?: string;
  fromLagDays?: number;
  toLagDays?: number;
}

export interface RevisionDiff {
  addedTasks: TaskChange[];
  removedTasks: TaskChange[];
  durationChanges: DurationChange[];
  dateChanges: DateChange[];
  progressChanges: (TaskChange & { fromPercent: number; toPercent: number })[];
  logicAdded: LogicChange[];
  logicRemoved: LogicChange[];
  logicChanged: LogicChange[];
  criticalityChanges: (TaskChange & { becameCritical: boolean })[];
  duplicateKeys: string[];
  totals: {
    from: number;
    to: number;
    added: number;
    removed: number;
    durationChanged: number;
    dateChanged: number;
    logicChanged: number;
  };
}

export function matchKey(t: DiffTask): string {
  if (t.externalId) return `x:${t.externalId}`;
  if (t.wbsCode) return `w:${t.wbsCode}|${t.name}`;
  return `n:${t.name}`;
}

function diffDays(a: string | null | undefined, b: string | null | undefined): number | null {
  if (!a || !b) return null;
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
}

const MAX_ITEMS = 2000;

export function diffRevisions(
  from: { tasks: DiffTask[]; dependencies: DiffDependency[] },
  to: { tasks: DiffTask[]; dependencies: DiffDependency[] },
): RevisionDiff {
  const duplicateKeys: string[] = [];
  const index = (tasks: DiffTask[]) => {
    const map = new Map<string, DiffTask>();
    for (const t of tasks) {
      const k = matchKey(t);
      if (map.has(k)) duplicateKeys.push(k);
      else map.set(k, t);
    }
    return map;
  };
  const fromMap = index(from.tasks);
  const toMap = index(to.tasks);

  const addedTasks: TaskChange[] = [];
  const removedTasks: TaskChange[] = [];
  const durationChanges: DurationChange[] = [];
  const dateChanges: DateChange[] = [];
  const progressChanges: RevisionDiff["progressChanges"] = [];
  const criticalityChanges: RevisionDiff["criticalityChanges"] = [];

  for (const [key, t] of toMap) {
    const prev = fromMap.get(key);
    if (!prev) {
      addedTasks.push({ key, name: t.name, fromId: null, toId: t.id });
      continue;
    }
    if (prev.durationDays !== t.durationDays) {
      durationChanges.push({
        key,
        name: t.name,
        fromId: prev.id,
        toId: t.id,
        fromDays: prev.durationDays,
        toDays: t.durationDays,
        deltaDays: t.durationDays - prev.durationDays,
      });
    }
    const startDelta = diffDays(t.startDate, prev.startDate);
    const finishDelta = diffDays(t.finishDate, prev.finishDate);
    if ((startDelta !== null && startDelta !== 0) || (finishDelta !== null && finishDelta !== 0)) {
      dateChanges.push({
        key,
        name: t.name,
        fromId: prev.id,
        toId: t.id,
        fromStart: prev.startDate ?? null,
        toStart: t.startDate ?? null,
        fromFinish: prev.finishDate ?? null,
        toFinish: t.finishDate ?? null,
        startDeltaDays: startDelta,
        finishDeltaDays: finishDelta,
      });
    }
    const fromPct = prev.percentComplete ?? 0;
    const toPct = t.percentComplete ?? 0;
    if (fromPct !== toPct) {
      progressChanges.push({ key, name: t.name, fromId: prev.id, toId: t.id, fromPercent: fromPct, toPercent: toPct });
    }
    if (prev.isCritical !== undefined && t.isCritical !== undefined && prev.isCritical !== t.isCritical) {
      criticalityChanges.push({ key, name: t.name, fromId: prev.id, toId: t.id, becameCritical: t.isCritical });
    }
  }
  for (const [key, t] of fromMap) {
    if (!toMap.has(key)) removedTasks.push({ key, name: t.name, fromId: t.id, toId: null });
  }

  /* ---- logic, keyed by the matched endpoints so ids may differ ---- */
  const keyOfId = (tasks: DiffTask[]) => {
    const m = new Map<string, string>();
    for (const t of tasks) m.set(t.id, matchKey(t));
    return m;
  };
  const fromIdKey = keyOfId(from.tasks);
  const toIdKey = keyOfId(to.tasks);
  const edgeIndex = (deps: DiffDependency[], ids: Map<string, string>) => {
    const m = new Map<string, DiffDependency & { predKey: string; succKey: string }>();
    for (const d of deps) {
      const p = ids.get(d.predecessorId);
      const s = ids.get(d.successorId);
      if (!p || !s) continue;
      m.set(`${p}->${s}`, { ...d, predKey: p, succKey: s });
    }
    return m;
  };
  const fromEdges = edgeIndex(from.dependencies, fromIdKey);
  const toEdges = edgeIndex(to.dependencies, toIdKey);

  const nameOf = (key: string): string => toMap.get(key)?.name ?? fromMap.get(key)?.name ?? key;
  const logicAdded: LogicChange[] = [];
  const logicRemoved: LogicChange[] = [];
  const logicChanged: LogicChange[] = [];
  for (const [k, edge] of toEdges) {
    const prev = fromEdges.get(k);
    if (!prev) {
      logicAdded.push({
        predecessor: nameOf(edge.predKey),
        successor: nameOf(edge.succKey),
        toType: edge.depType,
        toLagDays: edge.lagDays,
      });
    } else if (prev.depType !== edge.depType || prev.lagDays !== edge.lagDays) {
      logicChanged.push({
        predecessor: nameOf(edge.predKey),
        successor: nameOf(edge.succKey),
        fromType: prev.depType,
        toType: edge.depType,
        fromLagDays: prev.lagDays,
        toLagDays: edge.lagDays,
      });
    }
  }
  for (const [k, edge] of fromEdges) {
    if (!toEdges.has(k)) {
      logicRemoved.push({
        predecessor: nameOf(edge.predKey),
        successor: nameOf(edge.succKey),
        fromType: edge.depType,
        fromLagDays: edge.lagDays,
      });
    }
  }

  const cap = <T>(xs: T[]): T[] => xs.slice(0, MAX_ITEMS);
  return {
    addedTasks: cap(addedTasks),
    removedTasks: cap(removedTasks),
    durationChanges: cap(durationChanges),
    dateChanges: cap(dateChanges),
    progressChanges: cap(progressChanges),
    logicAdded: cap(logicAdded),
    logicRemoved: cap(logicRemoved),
    logicChanged: cap(logicChanged),
    criticalityChanges: cap(criticalityChanges),
    duplicateKeys: [...new Set(duplicateKeys)].slice(0, 100),
    totals: {
      from: from.tasks.length,
      to: to.tasks.length,
      added: addedTasks.length,
      removed: removedTasks.length,
      durationChanged: durationChanges.length,
      dateChanged: dateChanges.length,
      logicChanged: logicAdded.length + logicRemoved.length + logicChanged.length,
    },
  };
}
