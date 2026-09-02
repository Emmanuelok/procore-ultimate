/**
 * Reissue impact planning (spec Vol I #288) — pure.
 *
 * When a section is reissued, `diffClauses` says which paragraphs were
 * added, amended or removed. This module says what that DOES to the
 * requirements already read out of the old text:
 *
 *   removed clause  → requirement `superseded` (a registered one stays
 *                     registered but is reported: the submittal now cites a
 *                     clause that no longer exists)
 *   amended clause  → a confirmed requirement drops back to `identified`
 *                     with `needsReconfirmation`; the SoD chain re-runs. A
 *                     registered one is reported as `registered_changed`.
 *   added clause    → nothing here; the extractor reads the new text.
 *
 * A requirement anchored at "1.3.B.2" is affected by a change at "1.3.B.2",
 * at its parent "1.3.B", or at a child "1.3.B.2.a" — paragraph refs are a
 * tree, and a change anywhere on the path is a change to the citation.
 */
import type { ClauseChange } from "./parser.js";

export interface ReissueRequirement {
  id: string;
  paragraphRef: string | null;
  status: string;
  registeredSubmittalId: string | null;
}

export interface RegisteredChanged {
  requirementId: string;
  submittalId: string;
  paragraphRef: string | null;
  kind: "removed" | "amended";
}

export interface ReissuePlan {
  /** identified/confirmed rows whose clause was removed */
  superseded: string[];
  /** confirmed rows whose clause was amended: confirmation is void */
  reconfirm: string[];
  /** identified rows whose clause was amended: flagged, no status change */
  flagged: string[];
  /** registered rows whose clause changed under the submittal */
  registeredChanged: RegisteredChanged[];
  /** rows untouched by the reissue */
  unchanged: string[];
}

/** Is `ref` the same node as, an ancestor of, or a descendant of `changed`? */
export function refsOverlap(ref: string, changed: string): boolean {
  if (ref === changed) return true;
  return ref.startsWith(`${changed}.`) || changed.startsWith(`${ref}.`);
}

export function planReissue(changes: ClauseChange[], requirements: ReissueRequirement[]): ReissuePlan {
  const removed = changes.filter((c) => c.kind === "removed").map((c) => c.ref);
  const amended = changes.filter((c) => c.kind === "amended").map((c) => c.ref);
  const plan: ReissuePlan = {
    superseded: [],
    reconfirm: [],
    flagged: [],
    registeredChanged: [],
    unchanged: [],
  };
  for (const r of requirements) {
    if (r.status === "not_required" || r.status === "superseded") {
      plan.unchanged.push(r.id);
      continue;
    }
    const ref = r.paragraphRef;
    if (!ref) {
      plan.unchanged.push(r.id);
      continue;
    }
    const isRemoved = removed.some((c) => refsOverlap(ref, c));
    const isAmended = !isRemoved && amended.some((c) => refsOverlap(ref, c));
    if (!isRemoved && !isAmended) {
      plan.unchanged.push(r.id);
      continue;
    }
    if (r.status === "registered" && r.registeredSubmittalId) {
      plan.registeredChanged.push({
        requirementId: r.id,
        submittalId: r.registeredSubmittalId,
        paragraphRef: ref,
        kind: isRemoved ? "removed" : "amended",
      });
      continue;
    }
    if (isRemoved) {
      plan.superseded.push(r.id);
      continue;
    }
    if (r.status === "confirmed") plan.reconfirm.push(r.id);
    else plan.flagged.push(r.id);
  }
  return plan;
}
