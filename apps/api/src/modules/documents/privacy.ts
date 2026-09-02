/**
 * Folder privacy and ACL inheritance (spec Vol I #291, #297) — pure.
 *
 * Two facts the routes rely on, computed once per request from the
 * project's folder rows:
 *
 *  1. PRIVATE IS INHERITED. A private folder hides itself, every descendant
 *     folder and every file under any of them from users without documents
 *     admin. Containment is a path-prefix test on the materialised path.
 *  2. ACLs INHERIT DOWN, NEAREST WINS. `folders.permissions` maps a user id
 *     to a level; the level in force on a folder is the nearest
 *     ancestor-or-self entry for that user. No entry anywhere → the user's
 *     tool level applies. `none` hides the subtree from that user, `admin`
 *     lets them into private folders beneath it.
 */

export type FolderLevel = "none" | "read" | "standard" | "admin";

export interface FolderRow {
  id: string;
  path: string;
  isPrivate: number;
  permissions: Record<string, string> | null;
}

const LEVEL_RANK: Record<FolderLevel, number> = { none: 0, read: 1, standard: 2, admin: 3 };

export function isFolderLevel(v: unknown): v is FolderLevel {
  return v === "none" || v === "read" || v === "standard" || v === "admin";
}

export function levelAtLeast(level: FolderLevel, wanted: FolderLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[wanted];
}

/** Ids of every private folder AND every folder beneath one. */
export function privateSubtreeIds(folders: FolderRow[]): Set<string> {
  const privatePaths = folders.filter((f) => f.isPrivate === 1).map((f) => f.path);
  const out = new Set<string>();
  if (privatePaths.length === 0) return out;
  for (const f of folders) {
    if (f.isPrivate === 1 || privatePaths.some((p) => f.path.startsWith(`${p}/`))) out.add(f.id);
  }
  return out;
}

/** Every ancestor path of "/a/b/c" from deepest to root: ["/a/b/c", "/a/b", "/a"]. */
export function ancestorPaths(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  const out: string[] = [];
  for (let i = parts.length; i >= 1; i--) out.push(`/${parts.slice(0, i).join("/")}`);
  return out;
}

/**
 * The ACL level in force for a user on a folder, or null when no ancestor
 * (including the folder itself) names the user.
 */
export function effectiveAclLevel(
  folder: FolderRow,
  byPath: Map<string, FolderRow>,
  userId: string,
): FolderLevel | null {
  for (const p of ancestorPaths(folder.path)) {
    const row = byPath.get(p);
    const raw = row?.permissions?.[userId];
    if (isFolderLevel(raw)) return raw;
  }
  return null;
}

export interface FolderVisibility {
  /** folder ids the user must not see at all */
  hidden: Set<string>;
  /** folder ids where the user's effective level is at least `standard` */
  standard: Set<string>;
  /** folder ids where the user's effective level is `admin` (sees private beneath) */
  admin: Set<string>;
  /** the effective level per folder id */
  levels: Map<string, FolderLevel>;
}

/**
 * Resolve visibility for one user over a project's folders. `toolLevel` is
 * what the permission template gives them on the documents tool;
 * `seesPrivate` is the documents-admin / company-admin bypass.
 */
export function resolveFolderVisibility(
  folders: FolderRow[],
  userId: string,
  toolLevel: FolderLevel,
  seesPrivate: boolean,
): FolderVisibility {
  const byPath = new Map(folders.map((f) => [f.path, f] as const));
  const privateIds = privateSubtreeIds(folders);
  const hidden = new Set<string>();
  const standard = new Set<string>();
  const admin = new Set<string>();
  const levels = new Map<string, FolderLevel>();
  for (const f of folders) {
    const acl = effectiveAclLevel(f, byPath, userId);
    const level: FolderLevel = acl ?? toolLevel;
    levels.set(f.id, level);
    if (level === "none") {
      hidden.add(f.id);
      continue;
    }
    if (privateIds.has(f.id) && !seesPrivate && level !== "admin") {
      hidden.add(f.id);
      continue;
    }
    if (levelAtLeast(level, "standard")) standard.add(f.id);
    if (level === "admin") admin.add(f.id);
  }
  return { hidden, standard, admin, levels };
}

/** Sibling-name uniqueness helper: the path a rename/move would produce. */
export function childPath(parentPath: string, name: string): string {
  return `${parentPath}/${name}`;
}
