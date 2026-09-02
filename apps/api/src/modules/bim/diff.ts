/**
 * Model version comparison (spec #236) — pure.
 *
 * Given the element sets of two versions of the same model, it reports what
 * was added, removed and modified, keyed on the IFC GlobalId, which is the
 * only identifier that survives a re-export. "Modified" is decided by the
 * property hash computed at ingestion (name + type + classification + every
 * property set value), so a geometry-only re-export with unchanged data is
 * reported as unchanged rather than as a wholesale replacement.
 *
 * Deliberately not here: geometry differencing. Two elements with the same
 * GlobalId and the same property hash whose geometry moved are reported as
 * modified only if their extents changed, which the caller supplies as part
 * of the hash input.
 */

export interface DiffElement {
  globalId: string;
  ifcType: string;
  name: string | null;
  propertyHash: string | null;
  storey?: string | null;
}

export interface ModifiedElement {
  globalId: string;
  ifcType: string;
  name: string | null;
  previousName: string | null;
  previousIfcType: string;
  storey: string | null;
}

export interface TypeDelta {
  added: number;
  removed: number;
  modified: number;
}

export interface VersionDiff {
  added: DiffElement[];
  removed: DiffElement[];
  modified: ModifiedElement[];
  unchangedCount: number;
  byType: Record<string, TypeDelta>;
  /** GlobalIds that occur more than once in either version (model quality) */
  duplicateGlobalIds: string[];
}

function indexByGuid(elements: DiffElement[]): {
  map: Map<string, DiffElement>;
  duplicates: Set<string>;
} {
  const map = new Map<string, DiffElement>();
  const duplicates = new Set<string>();
  for (const el of elements) {
    if (map.has(el.globalId)) duplicates.add(el.globalId);
    else map.set(el.globalId, el);
  }
  return { map, duplicates };
}

function bump(byType: Record<string, TypeDelta>, ifcType: string, key: keyof TypeDelta): void {
  const entry = byType[ifcType] ?? { added: 0, removed: 0, modified: 0 };
  entry[key] += 1;
  byType[ifcType] = entry;
}

/** Compare `target` against `base`; both lists may contain duplicate GUIDs. */
export function diffVersions(base: DiffElement[], target: DiffElement[]): VersionDiff {
  const { map: baseMap, duplicates: baseDupes } = indexByGuid(base);
  const { map: targetMap, duplicates: targetDupes } = indexByGuid(target);

  const added: DiffElement[] = [];
  const removed: DiffElement[] = [];
  const modified: ModifiedElement[] = [];
  const byType: Record<string, TypeDelta> = {};
  let unchangedCount = 0;

  for (const [guid, targetEl] of targetMap) {
    const baseEl = baseMap.get(guid);
    if (!baseEl) {
      added.push(targetEl);
      bump(byType, targetEl.ifcType, "added");
      continue;
    }
    const changed =
      baseEl.propertyHash !== targetEl.propertyHash ||
      baseEl.ifcType !== targetEl.ifcType ||
      (baseEl.name ?? "") !== (targetEl.name ?? "");
    if (changed) {
      modified.push({
        globalId: guid,
        ifcType: targetEl.ifcType,
        name: targetEl.name,
        previousName: baseEl.name,
        previousIfcType: baseEl.ifcType,
        storey: targetEl.storey ?? null,
      });
      bump(byType, targetEl.ifcType, "modified");
    } else {
      unchangedCount += 1;
    }
  }

  for (const [guid, baseEl] of baseMap) {
    if (targetMap.has(guid)) continue;
    removed.push(baseEl);
    bump(byType, baseEl.ifcType, "removed");
  }

  const sortByGuid = (a: { globalId: string }, b: { globalId: string }) =>
    a.globalId < b.globalId ? -1 : a.globalId > b.globalId ? 1 : 0;
  added.sort(sortByGuid);
  removed.sort(sortByGuid);
  modified.sort(sortByGuid);

  return {
    added,
    removed,
    modified,
    unchangedCount,
    byType,
    duplicateGlobalIds: [...new Set([...baseDupes, ...targetDupes])].sort(),
  };
}

/**
 * Which open coordination issues are put at risk by a diff (#255): an issue
 * whose elements were removed or modified in the new version needs a look.
 */
export function issuesAffectedByDiff<T extends { id: string; elementGlobalIds: string[] }>(
  issues: T[],
  diff: Pick<VersionDiff, "removed" | "modified">,
): Array<{ issue: T; removed: string[]; modified: string[] }> {
  const removed = new Set(diff.removed.map((e) => e.globalId));
  const modified = new Set(diff.modified.map((e) => e.globalId));
  const out: Array<{ issue: T; removed: string[]; modified: string[] }> = [];
  for (const issue of issues) {
    const gone = issue.elementGlobalIds.filter((g) => removed.has(g));
    const changed = issue.elementGlobalIds.filter((g) => modified.has(g));
    if (gone.length > 0 || changed.length > 0) out.push({ issue, removed: gone, modified: changed });
  }
  return out;
}
