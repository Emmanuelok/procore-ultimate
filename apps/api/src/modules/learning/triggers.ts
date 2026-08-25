import { and, eq, inArray, isNotNull } from "drizzle-orm";
import {
  delayEvents,
  disputes,
  forensicClaims,
  gateReviews,
  projects,
  signals,
  stageGates,
  variations,
} from "@constructos/db";
import type { LessonTriggerKind } from "@constructos/shared";
import type { Db } from "../../lib/db.js";

/* ------------------------------------------------------------------ */
/* Trigger lifecycle                                                   */
/* ------------------------------------------------------------------ */

/**
 * A trigger is `open` until a lesson discharges it (`captured`) or someone
 * takes responsibility for refusing it (`dismissed`, which demands a named
 * dismisser and a recorded reason). There is no fourth state: a trigger
 * cannot quietly expire, which is the whole point of mandatory capture.
 */
export const LESSON_TRIGGER_STATUSES = ["open", "captured", "dismissed"] as const;
export type LessonTriggerStatus = (typeof LESSON_TRIGGER_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* Configurable threshold (#977)                                       */
/* ------------------------------------------------------------------ */

/** Variation value (absolute, project currency) above which capture is mandatory. */
export const DEFAULT_VARIATION_TRIGGER_THRESHOLD = 50_000;

export interface ThresholdResolution {
  value: number;
  source: "project" | "company" | "default";
}

function readThreshold(settings: Record<string, unknown> | null | undefined): number | null {
  const learning = settings?.["learning"];
  if (!learning || typeof learning !== "object" || Array.isArray(learning)) return null;
  const raw = (learning as Record<string, unknown>)["variationTriggerThreshold"];
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Resolve the mandatory-capture variation threshold: project settings beat
 * company settings beat the code default. Pure, so the precedence rule is
 * unit-testable without a database.
 *
 * Configure with `settings.learning.variationTriggerThreshold` on either the
 * project or the company row.
 */
export function resolveVariationThreshold(
  projectSettings: Record<string, unknown> | null | undefined,
  companySettings: Record<string, unknown> | null | undefined,
): ThresholdResolution {
  const fromProject = readThreshold(projectSettings);
  if (fromProject != null) return { value: fromProject, source: "project" };
  const fromCompany = readThreshold(companySettings);
  if (fromCompany != null) return { value: fromCompany, source: "company" };
  return { value: DEFAULT_VARIATION_TRIGGER_THRESHOLD, source: "default" };
}

/* ------------------------------------------------------------------ */
/* Rule contract                                                       */
/* ------------------------------------------------------------------ */

/** The record that fired a trigger — matches lessonTriggers.sourceRef. */
export interface TriggerSourceRef {
  tool: string;
  recordId: string;
  label: string;
  [key: string]: unknown;
}

export interface TriggerCandidate {
  kind: LessonTriggerKind;
  sourceRef: TriggerSourceRef;
  /** why this crossed the mandatory threshold, in words a human will read */
  rationale: string;
}

export interface TriggerScanContext {
  companyId: string;
  projectId: string;
  /** resolved mandatory-capture threshold for variation value */
  variationThreshold: number;
  /** project currency, for rendering money in rationales */
  currency: string;
}

export interface TriggerRule {
  kind: LessonTriggerKind;
  name: string;
  /** which platform records the rule reads, in prose (shown by the registry route) */
  reads: string;
  /** days from materialization by which the lesson is due */
  dueDays: number;
  scan(db: Db, ctx: TriggerScanContext): Promise<TriggerCandidate[]>;
}

/**
 * Stable identity of a trigger: one trigger per (kind, source record) per
 * project, forever. This is what makes the sweep idempotent — re-running it
 * against an unchanged project creates nothing.
 */
export function triggerKey(kind: string, recordId: string): string {
  return `${kind}:${recordId}`;
}

/** Candidates whose key is not already materialized. Pure — idempotency lives here. */
export function selectNewCandidates(
  candidates: readonly TriggerCandidate[],
  existingKeys: ReadonlySet<string>,
): TriggerCandidate[] {
  const seen = new Set(existingKeys);
  const out: TriggerCandidate[] = [];
  for (const c of candidates) {
    const key = triggerKey(c.kind, c.sourceRef.recordId);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Formatting helpers                                                  */
/* ------------------------------------------------------------------ */

function money(value: number | null | undefined, currency: string): string {
  if (value == null || !Number.isFinite(value)) return "an unstated amount";
  return `${currency} ${Math.round(value).toLocaleString("en-GB")}`;
}

function clip(text: string, max = 120): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/* ------------------------------------------------------------------ */
/* The rules                                                           */
/* ------------------------------------------------------------------ */

/**
 * A dispute that reached a determination, a settlement or a withdrawal is
 * finished as a commercial matter and unfinished as an organisational one.
 * Withdrawal is included deliberately: "why did we notify a dispute we then
 * dropped?" is one of the cheapest lessons on the platform.
 */
const CLOSED_DISPUTE_STATUSES = ["decided", "settled", "withdrawn"] as const;

const disputeClosed: TriggerRule = {
  kind: "dispute_closed",
  name: "Dispute closed",
  reads: "disputes (status decided | settled | withdrawn)",
  dueDays: 21,
  async scan(db, ctx) {
    const rows = await db
      .select()
      .from(disputes)
      .where(
        and(
          eq(disputes.companyId, ctx.companyId),
          eq(disputes.projectId, ctx.projectId),
          inArray(disputes.status, [...CLOSED_DISPUTE_STATUSES]),
        ),
      );
    return rows.map((d) => ({
      kind: "dispute_closed" as const,
      sourceRef: {
        tool: "disputes",
        recordId: d.id,
        label: `Dispute #${d.number} — ${clip(d.title)}`,
        status: d.status,
        amountInDispute: d.amountInDispute,
        currency: d.currency,
      },
      rationale:
        `${d.kind} dispute #${d.number} ("${clip(d.title)}") closed as ${d.status}` +
        `${d.outcome ? ` — ${clip(d.outcome, 160)}` : ""}, with ` +
        `${money(d.amountInDispute, d.currency)} in dispute. A dispute that ran to closure is ` +
        `the most expensive teaching the organisation buys; capture what would have avoided it.`,
    }));
  },
};

/**
 * A forensic claim reaching `agreed` is a settled claim: the entitlement
 * argument has been tested against a counterparty and priced.
 */
const claimSettled: TriggerRule = {
  kind: "claim_settled",
  name: "Claim settled",
  reads: "forensic_claims (status agreed)",
  dueDays: 21,
  async scan(db, ctx) {
    const rows = await db
      .select()
      .from(forensicClaims)
      .where(
        and(
          eq(forensicClaims.companyId, ctx.companyId),
          eq(forensicClaims.projectId, ctx.projectId),
          eq(forensicClaims.status, "agreed"),
        ),
      );
    return rows.map((c) => ({
      kind: "claim_settled" as const,
      sourceRef: {
        tool: "forensics",
        recordId: c.id,
        label: `Claim #${c.number} — ${clip(c.title)}`,
        kindOfClaim: c.kind,
        amountAssessed: c.amountAssessed,
        daysAssessed: c.daysAssessed,
      },
      rationale:
        `${c.kind} claim #${c.number} ("${clip(c.title)}") settled at ` +
        `${money(c.amountAssessed ?? c.amountClaimed, ctx.currency)}` +
        `${c.daysAssessed != null ? ` and ${c.daysAssessed} day(s) of extension` : ""}` +
        `${
          c.amountClaimed != null && c.amountAssessed != null && c.amountClaimed !== c.amountAssessed
            ? ` against ${money(c.amountClaimed, ctx.currency)} claimed`
            : ""
        }. The gap between claimed and recovered is the lesson.`,
    }));
  },
};

/** A delay event closed out: the cause is known and the effect is priced. */
const delayEventClosed: TriggerRule = {
  kind: "delay_event_closed",
  name: "Delay event closed",
  reads: "delay_events (status closed)",
  dueDays: 21,
  async scan(db, ctx) {
    const rows = await db
      .select()
      .from(delayEvents)
      .where(
        and(
          eq(delayEvents.companyId, ctx.companyId),
          eq(delayEvents.projectId, ctx.projectId),
          eq(delayEvents.status, "closed"),
        ),
      );
    return rows.map((e) => ({
      kind: "delay_event_closed" as const,
      sourceRef: {
        tool: "forensics",
        recordId: e.id,
        label: `Delay event #${e.number} — ${clip(e.title)}`,
        cause: e.cause,
        durationDays: e.durationDays,
      },
      rationale:
        `Delay event #${e.number} ("${clip(e.title)}", cause: ${e.cause}) closed after ` +
        `${e.durationDays} day(s)${e.excusable ? ", excusable" : ", non-excusable"}` +
        `${e.compensable ? " and compensable" : ""}. Record what the early warning was and ` +
        `whether the programme was ever going to absorb it.`,
    }));
  },
};

/**
 * A variation whose value crosses the configured threshold. Fires on the
 * first status at which a value is actually attached (`valued` or `agreed`);
 * a `proposed` variation is a request, not a number.
 */
const VALUED_VARIATION_STATUSES = ["valued", "agreed"] as const;

const variationThreshold: TriggerRule = {
  kind: "variation_threshold",
  name: "Variation over threshold",
  reads:
    "variations (status valued | agreed) whose agreedValue — falling back to costEstimate — " +
    "crosses settings.learning.variationTriggerThreshold",
  dueDays: 30,
  async scan(db, ctx) {
    const rows = await db
      .select()
      .from(variations)
      .where(
        and(
          eq(variations.companyId, ctx.companyId),
          eq(variations.projectId, ctx.projectId),
          inArray(variations.status, [...VALUED_VARIATION_STATUSES]),
        ),
      );
    const out: TriggerCandidate[] = [];
    for (const v of rows) {
      const value = v.agreedValue ?? v.costEstimate;
      if (value == null || Math.abs(value) < ctx.variationThreshold) continue;
      out.push({
        kind: "variation_threshold",
        sourceRef: {
          tool: "commercial",
          recordId: v.id,
          label: `Variation #${v.number} — ${clip(v.title)}`,
          value,
          status: v.status,
          basis: v.basis,
        },
        rationale:
          `Variation #${v.number} ("${clip(v.title)}") is valued at ` +
          `${money(value, ctx.currency)}, at or above the mandatory-capture threshold of ` +
          `${money(ctx.variationThreshold, ctx.currency)}. A change this size is either a ` +
          `design gap, a scope gap or a procurement gap — say which.`,
      });
    }
    return out;
  },
};

/**
 * A signal confirmed by the assurance layer. Only an `integrity_reviewer`
 * can disposition a signal (segregation of duties, ADR 0004), so a confirmed
 * signal carrying a reviewerId is by construction an independent finding.
 */
const signalConfirmed: TriggerRule = {
  kind: "signal_confirmed",
  name: "Signal confirmed by assurance",
  reads: "signals (disposition confirmed, reviewerId set by an integrity reviewer)",
  dueDays: 14,
  async scan(db, ctx) {
    const rows = await db
      .select()
      .from(signals)
      .where(
        and(
          eq(signals.companyId, ctx.companyId),
          eq(signals.projectId, ctx.projectId),
          eq(signals.disposition, "confirmed"),
          isNotNull(signals.reviewerId),
        ),
      );
    return rows.map((s) => ({
      kind: "signal_confirmed" as const,
      sourceRef: {
        tool: "assurance",
        recordId: s.id,
        label: `Signal — ${clip(s.title)}`,
        detector: s.detector,
        severity: s.severity,
      },
      rationale:
        `Integrity signal "${clip(s.title)}" (detector ${s.detector}, severity ${s.severity}) ` +
        `was confirmed by an independent reviewer. A confirmed signal is a control that did ` +
        `not hold; the lesson is the control change, not the incident.`,
    }));
  },
};

/** Every stage-gate review is a formal decision point and a formal learning point. */
const gateReview: TriggerRule = {
  kind: "gate_review",
  name: "Stage-gate review held",
  reads: "gate_reviews joined to stage_gates",
  dueDays: 30,
  async scan(db, ctx) {
    const rows = await db
      .select({
        id: gateReviews.id,
        reviewDate: gateReviews.reviewDate,
        rag: gateReviews.rag,
        decision: gateReviews.decision,
        gateNumber: stageGates.gateNumber,
        gateName: stageGates.name,
      })
      .from(gateReviews)
      .innerJoin(stageGates, eq(stageGates.id, gateReviews.gateId))
      .where(
        and(eq(gateReviews.companyId, ctx.companyId), eq(gateReviews.projectId, ctx.projectId)),
      );
    return rows.map((r) => ({
      kind: "gate_review" as const,
      sourceRef: {
        tool: "governance",
        recordId: r.id,
        label: `Gate ${r.gateNumber} review — ${clip(r.gateName)} (${r.reviewDate})`,
        decision: r.decision,
        rag: r.rag,
      },
      rationale:
        `Gate ${r.gateNumber} ("${clip(r.gateName)}") was reviewed on ${r.reviewDate} with a ` +
        `${r.decision.replace(/_/g, " ")} decision at ${r.rag.replace(/_/g, "/")} delivery ` +
        `confidence. Capture what the gate saw that the project had not, or what it missed.`,
    }));
  },
};

/** Project closeout: the last moment the team still exists. */
const projectCloseout: TriggerRule = {
  kind: "project_closeout",
  name: "Project closeout",
  reads: "projects (stage closed)",
  dueDays: 45,
  async scan(db, ctx) {
    const rows = await db
      .select({ id: projects.id, name: projects.name, number: projects.number })
      .from(projects)
      .where(
        and(
          eq(projects.id, ctx.projectId),
          eq(projects.companyId, ctx.companyId),
          eq(projects.stage, "closed"),
        ),
      )
      .limit(1);
    return rows.map((p) => ({
      kind: "project_closeout" as const,
      sourceRef: {
        tool: "projects",
        recordId: p.id,
        label: `Project closeout — ${clip(p.name)}`,
        projectNumber: p.number,
      },
      rationale:
        `Project "${clip(p.name)}" has moved to closed. Closeout is the last moment the delivery ` +
        `team still exists; a lesson captured after the team disperses is a memory, not a record.`,
    }));
  },
};

/**
 * The mandatory-capture rule set (#976-977). Every rule reads records that
 * another module already writes — no rule depends on anyone remembering to
 * tell the learning module anything.
 *
 * `manual` is a member of LESSON_TRIGGER_KINDS but has no sweep rule by
 * design: a human-raised trigger is not something the platform can detect.
 */
export const TRIGGER_RULES: readonly TriggerRule[] = [
  disputeClosed,
  claimSettled,
  delayEventClosed,
  variationThreshold,
  signalConfirmed,
  gateReview,
  projectCloseout,
];

/** The rule registry as data, for the UI and for anyone auditing the claim. */
export function describeTriggerRules() {
  return TRIGGER_RULES.map((r) => ({
    kind: r.kind,
    name: r.name,
    reads: r.reads,
    dueDays: r.dueDays,
  }));
}

/** Run every rule over one project and return the union of candidates. */
export async function scanTriggers(
  db: Db,
  ctx: TriggerScanContext,
): Promise<TriggerCandidate[]> {
  const out: TriggerCandidate[] = [];
  for (const rule of TRIGGER_RULES) {
    out.push(...(await rule.scan(db, ctx)));
  }
  return out;
}

/** Due-day lookup for a kind (used when materializing the obligation deadline). */
export function dueDaysFor(kind: LessonTriggerKind): number {
  return TRIGGER_RULES.find((r) => r.kind === kind)?.dueDays ?? 30;
}
