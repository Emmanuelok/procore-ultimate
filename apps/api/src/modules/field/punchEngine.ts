/**
 * Punch engine — pure rules for spec Vol I §2.8:
 *   #405–#413 ageing/completion analytics, walk mode grouping by location,
 *   #408      two-stage sign-off with segregation of duties,
 *   the before/after photo closure gate, and CSV export by vendor/trade.
 *
 * The authorisation function is the single source of truth for who may move
 * a punch item where; the route calls it and translates its verdict into a
 * 400/403. It never touches the database.
 */
import { average } from "./ageingEngine.js";
import { daysBetween } from "./dates.js";

export const PUNCH_OPEN_STATUSES = ["open", "in_progress", "ready_for_review"] as const;

/** Forward transitions of the punch lifecycle (void is handled separately). */
export const PUNCH_TRANSITIONS: Record<string, readonly string[]> = {
  open: ["in_progress", "ready_for_review"],
  in_progress: ["ready_for_review"],
  ready_for_review: ["closed", "in_progress"],
  closed: [],
  void: [],
};

export interface PunchSettings {
  /** closing requires at least one after photo (#403) */
  requireAfterPhoto: boolean;
  /** ready_for_review requires a verifier to be set */
  requireVerifier: boolean;
}

export const DEFAULT_PUNCH_SETTINGS: PunchSettings = {
  requireAfterPhoto: false,
  requireVerifier: false,
};

export interface PunchItemLike {
  status: string;
  assigneeId: string | null;
  verifierId: string | null;
  createdBy: string;
  readyForReviewBy: string | null;
  afterPhotoIds: readonly string[];
}

export type TransitionVerdict =
  | { ok: true }
  | { ok: false; status: 400 | 403; reason: string };

/**
 * Who may perform which transition:
 *  - void: company admin only, and never from closed (a completed sign-off
 *    is history, not something to erase);
 *  - ready_for_review: the assignee, the creator when unassigned, or an admin;
 *    requires a verifier when the project demands one and an after photo
 *    when the closure gate is on;
 *  - closed: the verifier (or an admin); the verifier must not be the
 *    assignee and must not be the person who marked it ready — two hands on
 *    every closure. With no verifier the creator may close, provided the
 *    creator is not the assignee.
 */
export function authorisePunchTransition(input: {
  item: PunchItemLike;
  actorId: string;
  isAdmin: boolean;
  to: string;
  settings?: Partial<PunchSettings>;
}): TransitionVerdict {
  const { item, actorId, isAdmin, to } = input;
  const settings = { ...DEFAULT_PUNCH_SETTINGS, ...(input.settings ?? {}) };
  if (to === "void") {
    if (!isAdmin) return { ok: false, status: 403, reason: "Only a company admin can void a punch item" };
    if (item.status === "void") return { ok: false, status: 400, reason: "Punch item is already void" };
    if (item.status === "closed") {
      return { ok: false, status: 400, reason: "A closed (verified) punch item cannot be voided" };
    }
    return { ok: true };
  }
  const allowed = PUNCH_TRANSITIONS[item.status] ?? [];
  if (!allowed.includes(to)) {
    return { ok: false, status: 400, reason: `Cannot transition from ${item.status} to ${to}` };
  }
  if (to === "ready_for_review") {
    const responsible = item.assigneeId ?? item.createdBy;
    if (actorId !== responsible && !isAdmin) {
      return { ok: false, status: 403, reason: "Only the assignee can mark a punch item ready for review" };
    }
    if (settings.requireVerifier && !item.verifierId) {
      return { ok: false, status: 400, reason: "A verifier must be set before the item is ready for review" };
    }
    if (settings.requireAfterPhoto && item.afterPhotoIds.length === 0) {
      return { ok: false, status: 400, reason: "At least one after photo is required before review" };
    }
    return { ok: true };
  }
  if (to === "closed") {
    if (settings.requireAfterPhoto && item.afterPhotoIds.length === 0) {
      return { ok: false, status: 400, reason: "At least one after photo is required to close the item" };
    }
    if (item.readyForReviewBy && item.readyForReviewBy === actorId && !isAdmin) {
      return {
        ok: false,
        status: 403,
        reason: "The person who marked the item ready cannot also verify it",
      };
    }
    if (item.assigneeId && item.assigneeId === actorId && !isAdmin) {
      return { ok: false, status: 403, reason: "The assignee cannot verify their own punch item" };
    }
    if (item.verifierId) {
      if (actorId === item.verifierId || isAdmin) return { ok: true };
      return { ok: false, status: 403, reason: "Only the verifier or a company admin can close a punch item" };
    }
    if (actorId === item.createdBy || isAdmin) return { ok: true };
    return {
      ok: false,
      status: 403,
      reason: "With no verifier set, only the creator or a company admin can close a punch item",
    };
  }
  // in_progress (start work / send back)
  return { ok: true };
}

/**
 * Verifier assignment rules: the verifier may never be the assignee, and once
 * an item is ready for review its verifier is locked unless an admin changes
 * it (#408 — an assignee must not be able to pick their own judge).
 */
export function validateVerifierChange(input: {
  item: { status: string; verifierId: string | null; assigneeId: string | null };
  nextVerifierId: string | null | undefined;
  nextAssigneeId: string | null | undefined;
  actorId: string;
  isAdmin: boolean;
}): TransitionVerdict {
  const { item, actorId, isAdmin } = input;
  const verifier = input.nextVerifierId === undefined ? item.verifierId : input.nextVerifierId;
  const assignee = input.nextAssigneeId === undefined ? item.assigneeId : input.nextAssigneeId;
  if (verifier && assignee && verifier === assignee) {
    return { ok: false, status: 400, reason: "The verifier must be a different person from the assignee" };
  }
  const verifierChanged = input.nextVerifierId !== undefined && input.nextVerifierId !== item.verifierId;
  if (verifierChanged && !isAdmin) {
    if (item.status === "ready_for_review") {
      return { ok: false, status: 403, reason: "The verifier is locked once the item is ready for review" };
    }
    if (input.nextVerifierId === actorId && item.assigneeId === actorId) {
      return { ok: false, status: 403, reason: "An assignee cannot appoint themselves verifier" };
    }
  }
  const assigneeChanged = input.nextAssigneeId !== undefined && input.nextAssigneeId !== item.assigneeId;
  if (assigneeChanged && item.status === "ready_for_review" && !isAdmin) {
    return { ok: false, status: 403, reason: "The assignee is locked once the item is ready for review" };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Walk mode — grouping by location (#401, #402)                       */
/* ------------------------------------------------------------------ */

export interface LocationLike {
  id: string;
  name: string;
  parentId: string | null;
  path: string;
}

export interface LocationGroup<T> {
  locationId: string | null;
  name: string;
  /** "Building A / Level 3 / Room 301" */
  pathLabel: string;
  path: string;
  counts: { open: number; in_progress: number; ready_for_review: number; closed: number; void: number };
  items: T[];
}

/** Group items by location, in tree (path) order; unlocated items last. */
export function groupByLocation<T extends { locationId: string | null; status: string }>(
  items: readonly T[],
  locations: readonly LocationLike[],
): LocationGroup<T>[] {
  const byId = new Map(locations.map((l) => [l.id, l]));
  const labelOf = (loc: LocationLike): string => {
    const names: string[] = [];
    let cursor: LocationLike | undefined = loc;
    let guard = 0;
    while (cursor && guard < 32) {
      names.unshift(cursor.name);
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
      guard += 1;
    }
    return names.join(" / ");
  };
  const groups = new Map<string, LocationGroup<T>>();
  const emptyCounts = () => ({ open: 0, in_progress: 0, ready_for_review: 0, closed: 0, void: 0 });
  for (const item of items) {
    const loc = item.locationId ? byId.get(item.locationId) : undefined;
    const key = loc ? loc.id : "__unlocated";
    let g = groups.get(key);
    if (!g) {
      g = loc
        ? { locationId: loc.id, name: loc.name, pathLabel: labelOf(loc), path: loc.path, counts: emptyCounts(), items: [] }
        : { locationId: null, name: "No location", pathLabel: "No location", path: "~", counts: emptyCounts(), items: [] };
      groups.set(key, g);
    }
    g.items.push(item);
    const status = item.status as keyof LocationGroup<T>["counts"];
    if (status in g.counts) g.counts[status] += 1;
  }
  return [...groups.values()].sort((a, b) => {
    if (a.locationId === null) return 1;
    if (b.locationId === null) return -1;
    return a.path.localeCompare(b.path);
  });
}

/* ------------------------------------------------------------------ */
/* Completion analytics (#411–#413)                                    */
/* ------------------------------------------------------------------ */

export interface CompletionStats {
  total: number;
  open: number;
  closed: number;
  void: number;
  completionPct: number | null;
  avgDaysToClose: number | null;
  overdue: number;
  basis: string;
}

export function completionStats(
  items: readonly { status: string; createdAt: string; closedAt: string | null; dueDate: string | null }[],
  todayIso: string,
): CompletionStats {
  const live = items.filter((i) => i.status !== "void");
  const closed = live.filter((i) => i.status === "closed");
  const open = live.length - closed.length;
  const durations = closed
    .filter((i) => i.closedAt)
    .map((i) => Math.max(0, daysBetween(i.createdAt, i.closedAt!)));
  const overdue = live.filter(
    (i) => i.status !== "closed" && !!i.dueDate && i.dueDate < todayIso,
  ).length;
  return {
    total: live.length,
    open,
    closed: closed.length,
    void: items.length - live.length,
    completionPct: live.length > 0 ? Math.round((closed.length / live.length) * 1000) / 10 : null,
    avgDaysToClose: average(durations),
    overdue,
    basis:
      live.length > 0
        ? `${closed.length} closed of ${live.length} non-void items; days-to-close from created to closed timestamps`
        : "No non-void punch items yet",
  };
}

/* ------------------------------------------------------------------ */
/* CSV export                                                          */
/* ------------------------------------------------------------------ */

function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(
  rows: readonly Record<string, unknown>[],
  columns: readonly { key: string; header: string }[],
): string {
  const lines = [columns.map((c) => csvCell(c.header)).join(",")];
  for (const row of rows) lines.push(columns.map((c) => csvCell(row[c.key])).join(","));
  return lines.join("\r\n") + "\r\n";
}
