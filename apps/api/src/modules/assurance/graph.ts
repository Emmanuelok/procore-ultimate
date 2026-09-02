/**
 * Entity-graph intelligence: beneficial-ownership paths, undeclared conflicts
 * of interest and shell-company indicators (spec Vol II Domain A #44-52).
 *
 * The graph is the part of integrity work that a register cannot do. A single
 * supplier record looks innocent; the fact that its sole director is also the
 * spouse of the person who approves its invoices lives in the EDGES, and only
 * becomes visible when you walk them.
 *
 * Two findings come out of that walk:
 *
 *   UNDECLARED CONFLICT — there is a path from an approver to a supplier they
 *   approved, and no matching entry on the conflict-of-interest register. The
 *   register is what makes this fair: a declared relationship is not a finding,
 *   it is governance working. An undeclared one is the finding.
 *
 *   SHELL INDICATORS — an entity incorporated shortly before it first won work
 *   here, whose only client is us. Not proof of anything; the arithmetic that
 *   makes a question worth asking.
 *
 * PURE: rows in, paths and drafts out.
 */
import { fingerprintOf, sortedIds, type SignalDraft } from "./detectors.js";

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: string;
  confidence: number | null;
  source: string | null;
}

export interface GraphNodeLike {
  id: string;
  name: string;
  kind: string;
  /** ISO date the entity was incorporated / came into existence, if known */
  incorporatedOn?: string | null;
}

export interface GraphPath {
  /** node ids from root to target inclusive */
  nodes: string[];
  /** edges walked, in order */
  edges: GraphEdge[];
  length: number;
}

/** Relationship kinds that carry an INTEREST, as opposed to a coincidence. */
export const INTEREST_KINDS = new Set([
  "director_of",
  "beneficial_owner_of",
  "shareholder_of",
  "employee_of",
  "related_party",
  "subsidiary_of",
]);

/** Relationship kinds inferred from shared identifiers — weaker, still walked. */
export const COINCIDENCE_KINDS = new Set([
  "shares_address_with",
  "shares_bank_account_with",
  "shares_contact_with",
]);

function adjacencyOf(edges: GraphEdge[]): Map<string, GraphEdge[]> {
  const adj = new Map<string, GraphEdge[]>();
  for (const e of edges) {
    for (const end of [e.from, e.to]) {
      const list = adj.get(end) ?? [];
      list.push(e);
      adj.set(end, list);
    }
  }
  return adj;
}

/**
 * Shortest path between two entities, treating relationships as undirected
 * (a directorship links the two parties whichever way the row was written).
 * Returns null when no path exists within `maxDepth`.
 */
export function shortestPath(
  edges: GraphEdge[],
  fromId: string,
  toId: string,
  maxDepth = 3,
): GraphPath | null {
  if (fromId === toId) return { nodes: [fromId], edges: [], length: 0 };
  const adj = adjacencyOf(edges);
  const prev = new Map<string, { node: string; edge: GraphEdge }>();
  const seen = new Set<string>([fromId]);
  let frontier = [fromId];
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const edge of adj.get(node) ?? []) {
        const other = edge.from === node ? edge.to : edge.from;
        if (seen.has(other)) continue;
        seen.add(other);
        prev.set(other, { node, edge });
        if (other === toId) {
          const nodes: string[] = [toId];
          const walked: GraphEdge[] = [];
          let cursor = toId;
          while (cursor !== fromId) {
            const step = prev.get(cursor);
            if (!step) break;
            walked.unshift(step.edge);
            nodes.unshift(step.node);
            cursor = step.node;
          }
          return { nodes, edges: walked, length: walked.length };
        }
        next.push(other);
      }
    }
    frontier = next;
  }
  return null;
}

/** Every entity reachable from a root within `maxDepth`, with the path taken. */
export function reachableFrom(
  edges: GraphEdge[],
  rootId: string,
  maxDepth = 3,
): Array<{ targetId: string; path: GraphPath }> {
  const adj = adjacencyOf(edges);
  const prev = new Map<string, { node: string; edge: GraphEdge }>();
  const seen = new Set<string>([rootId]);
  const out: Array<{ targetId: string; path: GraphPath }> = [];
  let frontier = [rootId];
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const edge of adj.get(node) ?? []) {
        const other = edge.from === node ? edge.to : edge.from;
        if (seen.has(other)) continue;
        seen.add(other);
        prev.set(other, { node, edge });
        next.push(other);
        const nodes: string[] = [other];
        const walked: GraphEdge[] = [];
        let cursor = other;
        while (cursor !== rootId) {
          const step = prev.get(cursor);
          if (!step) break;
          walked.unshift(step.edge);
          nodes.unshift(step.node);
          cursor = step.node;
        }
        out.push({ targetId: other, path: { nodes, edges: walked, length: walked.length } });
      }
    }
    frontier = next;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Undeclared conflicts of interest                                    */
/* ------------------------------------------------------------------ */

export interface ApprovalEdge {
  id: string;
  approverId: string;
  vendorId: string;
  objectType: string;
  objectId: string;
  amount: number | null;
  currency: string | null;
  decidedAt: string;
}

export interface ConflictDeclarationLike {
  userId: string;
  entityId: string;
  nature: string;
  endedAt: string | null;
}

/**
 * A path from an approver's own entity record to a supplier they approved,
 * with nothing on the conflict register covering it.
 *
 * `userEntityId` maps a platform user to their entity node — the assurance
 * layer's person record. Without that mapping there is no path to walk, so an
 * organisation that never mirrors its people into the entity graph gets no
 * findings here, and the run reports that rather than pretending to have
 * looked.
 */
export function undeclaredConflicts(input: {
  edges: GraphEdge[];
  approvals: ApprovalEdge[];
  /** platform userId → entity id */
  userEntityId: Map<string, string>;
  /** vendorId → entity id */
  vendorEntityId: Map<string, string>;
  entityNames: Map<string, string>;
  declarations: ConflictDeclarationLike[];
  maxDepth?: number;
}): SignalDraft[] {
  const maxDepth = input.maxDepth ?? 3;
  const declared = new Set(
    input.declarations.filter((d) => !d.endedAt).map((d) => `${d.userId}|${d.entityId}`),
  );
  const pairs = new Map<string, ApprovalEdge[]>();
  for (const a of input.approvals) {
    const key = `${a.approverId}|${a.vendorId}`;
    const list = pairs.get(key) ?? [];
    list.push(a);
    pairs.set(key, list);
  }

  const drafts: SignalDraft[] = [];
  for (const [key, approvals] of pairs) {
    const [approverId, vendorId] = key.split("|") as [string, string];
    const personEntity = input.userEntityId.get(approverId);
    const vendorEntity = input.vendorEntityId.get(vendorId);
    if (!personEntity || !vendorEntity) continue;
    if (declared.has(`${approverId}|${vendorEntity}`)) continue;
    const path = shortestPath(input.edges, personEntity, vendorEntity, maxDepth);
    if (!path || path.length === 0) continue;
    const interestEdges = path.edges.filter((e) => INTEREST_KINDS.has(e.kind));
    const severity = interestEdges.length > 0 ? "critical" : "high";
    const hops = path.edges
      .map(
        (e) =>
          `${input.entityNames.get(e.from) ?? e.from} —${e.kind}→ ${input.entityNames.get(e.to) ?? e.to}`,
      )
      .join("; ");
    drafts.push({
      detector: "undeclared_conflict",
      severity,
      confidence: interestEdges.length > 0 ? 0.9 : 0.65,
      title: `${approverId} approved ${input.entityNames.get(vendorEntity) ?? vendorId} and is connected to it`,
      explanation:
        `This approver decided ${approvals.length} approval(s) for a supplier they are linked to ` +
        `through ${path.length} relationship hop(s): ${hops}. There is no current entry on the ` +
        "conflict-of-interest register covering this pair. A declared interest is governance " +
        "working; an undeclared one is the finding (Domain A #45-47). Either record the " +
        "declaration and re-route the approvals, or explain why the graph edge is wrong.",
      evidenceRefs: {
        approverId,
        vendorId,
        personEntityId: personEntity,
        vendorEntityId: vendorEntity,
        pathLength: path.length,
        path: path.edges.map((e) => ({ id: e.id, from: e.from, to: e.to, kind: e.kind })),
        approvalIds: approvals.map((a) => a.id),
        interestEdges: interestEdges.length,
      },
      fingerprint: fingerprintOf(approverId, vendorId, sortedIds(path.edges.map((e) => e.id))),
      subjectType: "user",
      subjectId: approverId,
      links: [
        { objectType: "entity", objectId: vendorEntity, role: "subject" },
        { objectType: "vendor", objectId: vendorId, role: "subject" },
        ...approvals.map((a) => ({ objectType: a.objectType, objectId: a.objectId })),
      ],
    });
  }
  return drafts;
}

/* ------------------------------------------------------------------ */
/* Shell-company indicators                                            */
/* ------------------------------------------------------------------ */

export interface AwardLike {
  entityId: string | null;
  vendorId: string | null;
  objectId: string;
  awardedOn: string | null;
  amount: number | null;
  currency: string | null;
}

/**
 * Entities incorporated shortly before their first award, with a single
 * client (us). Each indicator is reported with the date arithmetic behind it,
 * because "recently incorporated" is a fact and "shell company" is a
 * conclusion this module does not draw.
 */
export function shellCompanyIndicators(input: {
  entities: GraphNodeLike[];
  awards: AwardLike[];
  entityByVendor: Map<string, string>;
  incorporationWindowDays?: number;
}): SignalDraft[] {
  const window = input.incorporationWindowDays ?? 180;
  const byEntity = new Map<string, AwardLike[]>();
  for (const a of input.awards) {
    const entityId = a.entityId ?? (a.vendorId ? input.entityByVendor.get(a.vendorId) : undefined);
    if (!entityId) continue;
    const list = byEntity.get(entityId) ?? [];
    list.push(a);
    byEntity.set(entityId, list);
  }
  const drafts: SignalDraft[] = [];
  for (const entity of input.entities) {
    const incorporated = entity.incorporatedOn ? Date.parse(entity.incorporatedOn) : NaN;
    if (Number.isNaN(incorporated)) continue;
    const awards = byEntity.get(entity.id) ?? [];
    const dated = awards
      .map((a) => ({ a, t: a.awardedOn ? Date.parse(a.awardedOn) : NaN }))
      .filter((x) => !Number.isNaN(x.t))
      .sort((x, y) => x.t - y.t);
    if (dated.length === 0) continue;
    const first = dated[0]!;
    const days = Math.round((first.t - incorporated) / 86_400_000);
    if (days < 0 || days > window) continue;
    drafts.push({
      detector: "shell_company_indicators",
      severity: days <= 60 ? "high" : "medium",
      confidence: 0.6,
      title: `${entity.name} won work ${days} days after incorporation`,
      explanation:
        `This entity was incorporated on ${entity.incorporatedOn} and its first award here ` +
        `(${first.a.objectId}) is dated ${first.a.awardedOn} — ${days} days later, inside the ` +
        `${window}-day window this detector tests. It holds ${dated.length} award(s) with this ` +
        "organisation. A company formed shortly before it wins its first contract, whose only " +
        "client is the awarding body, has no independent trading history to check " +
        "(Domain A #48-52). Ask for accounts, other customers and a registered address that is " +
        "not a mail drop.",
      evidenceRefs: {
        entityId: entity.id,
        incorporatedOn: entity.incorporatedOn,
        firstAwardOn: first.a.awardedOn,
        daysToFirstAward: days,
        awardCount: dated.length,
        awardIds: dated.map((x) => x.a.objectId),
      },
      fingerprint: fingerprintOf(entity.id, first.a.objectId),
      subjectType: "entity",
      subjectId: entity.id,
      links: [{ objectType: "entity", objectId: entity.id, role: "subject" }],
    });
  }
  return drafts;
}
