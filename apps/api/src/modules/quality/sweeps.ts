/**
 * The quality sweeps.
 *
 * They run in TWO places, and the second one is the important one. Every
 * sweep runs at the top of the list reads of the register it concerns, so an
 * open page is always telling the truth; and every sweep is also registered
 * as a scheduler job (./jobs.ts), because a platform whose product is "the
 * hold point was never released and here is the record" cannot depend on
 * somebody opening a browser tab to notice.
 *
 * Four detectors, each keyed in `signals.evidenceRefs.key` so a second read
 * of the same page raises nothing:
 *
 *   quality_hold_point_unreleased      key = itp activity id
 *   quality_ncr_response_overdue       key = ncr id
 *   quality_turnover_artefacts_missing key = turnover package id
 *   quality_system_deficiencies_overdue key = commissioning system id
 *
 * Idempotency is asserted by tests, not assumed: the sweep is safe to call on
 * every request because calling it twice produces one signal.
 */

import { and, eq, inArray } from "drizzle-orm";
import {
  commissioningSystems,
  inspectionTestPlans,
  itpActivities,
  nonConformanceReports,
  turnoverPackages,
} from "@constructos/db";
import type { SignalSeverity } from "@constructos/shared";
import type { Db } from "../../lib/db.js";
import {
  alreadySignalled,
  QUALITY_DETECTORS,
  raiseSignal,
  todayISO,
  type QualityDetector,
} from "./shared.js";
import { isUnreleasedPastPlannedDate, parseVerifyingParties, describeParties } from "./holdPoints.js";

/** NCR statuses at which a response is still owed. */
const NCR_AWAITING_RESPONSE = [
  "open",
  "under_review",
  "disposition_proposed",
] as const;

/** Turnover statuses at which the artefact gap is somebody's problem now. */
const TURNOVER_IN_FLIGHT = ["assembling", "submitted", "under_review", "resubmitted"] as const;

const severityForNcr = (severity: string): SignalSeverity =>
  severity === "critical" ? "critical" : severity === "major" ? "high" : "medium";

export interface SweepOutcome {
  raised: number;
  byDetector: Record<QualityDetector, number>;
}

export const emptyOutcome = (): SweepOutcome => {
  const byDetector = {} as Record<QualityDetector, number>;
  for (const detector of Object.values(QUALITY_DETECTORS)) byDetector[detector] = 0;
  return { raised: 0, byDetector };
};

/* ------------------------------------------------------------------ */
/* 1. Unreleased hold point past its planned date                      */
/* ------------------------------------------------------------------ */

async function sweepHoldPoints(
  db: Db,
  companyId: string,
  projectId: string,
  actorId: string | null,
  asOf: string,
  outcome: SweepOutcome,
): Promise<void> {
  const rows = await db
    .select()
    .from(itpActivities)
    .where(
      and(
        eq(itpActivities.companyId, companyId),
        eq(itpActivities.projectId, projectId),
        eq(itpActivities.interventionPoint, "hold_point"),
      ),
    );
  const overdue = rows.filter((a) => isUnreleasedPastPlannedDate(a, asOf));
  if (overdue.length === 0) return;

  const seen = await alreadySignalled(db, companyId, QUALITY_DETECTORS.holdPointUnreleased);
  const itpIds = [...new Set(overdue.map((a) => a.itpId))];
  const plans = itpIds.length
    ? await db
        .select({
          id: inspectionTestPlans.id,
          reference: inspectionTestPlans.reference,
          title: inspectionTestPlans.title,
        })
        .from(inspectionTestPlans)
        .where(inArray(inspectionTestPlans.id, itpIds))
    : [];
  const planById = new Map(plans.map((p) => [p.id, p] as const));

  for (const a of overdue) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    const plan = planById.get(a.itpId);
    const parties = describeParties(parseVerifyingParties(a.verifyingParties));
    const notice = a.notifiedAt
      ? `Notice was served at ${a.notifiedAt}${a.notificationMethod ? ` by ${a.notificationMethod}` : ""}.`
      : "No notice has been served on this point at all, so the verifying party has not even been invited.";
    await raiseSignal(db, companyId, projectId, actorId, {
      detector: QUALITY_DETECTORS.holdPointUnreleased,
      severity: "high",
      confidence: 1,
      title: `Hold point still unreleased past its planned date — ${plan?.reference ?? a.itpId} / ${a.activity}`,
      explanation:
        `Hold point "${a.activity}"${a.activityCode ? ` (${a.activityCode})` : ""} on ${plan ? `${plan.reference} ${plan.title}` : `ITP ${a.itpId}`} ` +
        `was planned for ${a.plannedDate} and is still ${a.status}. ${notice} ` +
        `The nominated verifying party is ${parties}. ` +
        `Work may not proceed past an unreleased hold point: either the work is standing idle waiting for a release that nobody has chased, ` +
        `or it went ahead without one — and if it went ahead, the verification can no longer be made and the covering-up allegation follows. ` +
        `Release it, waive it in writing with a reason, or record why the point no longer applies.`,
      key: a.id,
      evidence: {
        activityId: a.id,
        itpId: a.itpId,
        itpReference: plan?.reference ?? null,
        plannedDate: a.plannedDate,
        status: a.status,
        notifiedAt: a.notifiedAt,
        noticePeriodHours: a.noticePeriodHours,
      },
    });
    outcome.raised += 1;
    outcome.byDetector[QUALITY_DETECTORS.holdPointUnreleased] += 1;
  }
}

/* ------------------------------------------------------------------ */
/* 2. NCR past its response due date                                   */
/* ------------------------------------------------------------------ */

async function sweepNcrs(
  db: Db,
  companyId: string,
  projectId: string,
  actorId: string | null,
  asOf: string,
  outcome: SweepOutcome,
): Promise<void> {
  const rows = await db
    .select()
    .from(nonConformanceReports)
    .where(
      and(
        eq(nonConformanceReports.companyId, companyId),
        eq(nonConformanceReports.projectId, projectId),
        inArray(nonConformanceReports.status, [...NCR_AWAITING_RESPONSE]),
      ),
    );
  const overdue = rows.filter((n) => n.responseDueDate !== null && n.responseDueDate < asOf);
  if (overdue.length === 0) return;
  const seen = await alreadySignalled(db, companyId, QUALITY_DETECTORS.ncrResponseOverdue);
  for (const n of overdue) {
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    await raiseSignal(db, companyId, projectId, actorId, {
      detector: QUALITY_DETECTORS.ncrResponseOverdue,
      severity: severityForNcr(n.severity),
      confidence: 1,
      title: `NCR ${n.reference} past its response due date — ${n.title}`,
      explanation:
        `${n.reference} (${n.severity} ${n.category}) was due a response by ${n.responseDueDate} and is still ${n.status} ` +
        `with disposition "${n.disposition}". ${n.raisedAgainstVendorId ? `It is raised against vendor ${n.raisedAgainstVendorId}. ` : ""}` +
        `Non-conforming work sits in the building while the disposition is open, and every day it stays open is a day the ` +
        `rectification gets more expensive and the evidence of what was actually built gets thinner. ` +
        `Propose a disposition, or record why the due date moved.`,
      key: n.id,
      evidence: {
        ncrId: n.id,
        reference: n.reference,
        responseDueDate: n.responseDueDate,
        status: n.status,
        disposition: n.disposition,
        severity: n.severity,
        raisedAgainstVendorId: n.raisedAgainstVendorId,
      },
    });
    outcome.raised += 1;
    outcome.byDetector[QUALITY_DETECTORS.ncrResponseOverdue] += 1;
  }
}

/* ------------------------------------------------------------------ */
/* 3. Turnover package short of its required artefacts                 */
/* ------------------------------------------------------------------ */

async function sweepTurnover(
  db: Db,
  companyId: string,
  projectId: string,
  actorId: string | null,
  outcome: SweepOutcome,
): Promise<void> {
  const rows = await db
    .select()
    .from(turnoverPackages)
    .where(
      and(
        eq(turnoverPackages.companyId, companyId),
        eq(turnoverPackages.projectId, projectId),
        inArray(turnoverPackages.status, [...TURNOVER_IN_FLIGHT]),
      ),
    );
  const short = rows.filter(
    (p) => p.requiredArtefactCount > 0 && p.presentArtefactCount < p.requiredArtefactCount,
  );
  if (short.length === 0) return;
  const seen = await alreadySignalled(db, companyId, QUALITY_DETECTORS.turnoverArtefactsMissing);
  for (const p of short) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    const missing = missingArtefactKinds(p.contents);
    await raiseSignal(db, companyId, projectId, actorId, {
      detector: QUALITY_DETECTORS.turnoverArtefactsMissing,
      severity: p.status === "submitted" || p.status === "under_review" ? "high" : "medium",
      confidence: 1,
      title: `Turnover package ${p.reference} is short ${p.requiredArtefactCount - p.presentArtefactCount} required artefact(s)`,
      explanation:
        `${p.reference} "${p.name}" is ${p.status} with ${p.presentArtefactCount} of ${p.requiredArtefactCount} required artefacts present. ` +
        `Missing: ${missing.length > 0 ? missing.join(", ") : "(the contents list records a shortfall but names no kinds)"}. ` +
        `The gap is the whole value of a turnover package: an owner who accepts a package without the O&Ms, the as-builts or the ` +
        `statutory certificates inherits a building nobody can operate or prove compliant, and the missing documents are never ` +
        `easier to obtain than they are today, while the contractor is still on site and still unpaid.`,
      key: p.id,
      evidence: {
        packageId: p.id,
        reference: p.reference,
        status: p.status,
        requiredArtefactCount: p.requiredArtefactCount,
        presentArtefactCount: p.presentArtefactCount,
        missingKinds: missing,
      },
    });
    outcome.raised += 1;
    outcome.byDetector[QUALITY_DETECTORS.turnoverArtefactsMissing] += 1;
  }
}

/** Kinds declared required on the contents checklist and not yet present. */
export function missingArtefactKinds(contents: unknown): string[] {
  if (!Array.isArray(contents)) return [];
  const out: string[] = [];
  for (const entry of contents) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    if (rec["required"] === true && rec["present"] !== true && typeof rec["kind"] === "string") {
      out.push(rec["kind"]);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 4. System with open deficiencies past its planned completion        */
/* ------------------------------------------------------------------ */

async function sweepSystems(
  db: Db,
  companyId: string,
  projectId: string,
  actorId: string | null,
  asOf: string,
  outcome: SweepOutcome,
): Promise<void> {
  const rows = await db
    .select()
    .from(commissioningSystems)
    .where(
      and(
        eq(commissioningSystems.companyId, companyId),
        eq(commissioningSystems.projectId, projectId),
      ),
    );
  const overdue = rows.filter(
    (s) =>
      s.openDeficiencyCount > 0 &&
      s.plannedCompletionDate !== null &&
      s.plannedCompletionDate < asOf &&
      s.status !== "turned_over",
  );
  if (overdue.length === 0) return;
  const seen = await alreadySignalled(db, companyId, QUALITY_DETECTORS.systemDeficienciesOverdue);
  for (const s of overdue) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    await raiseSignal(db, companyId, projectId, actorId, {
      detector: QUALITY_DETECTORS.systemDeficienciesOverdue,
      severity: "medium",
      confidence: 1,
      title: `${s.systemCode} carries ${s.openDeficiencyCount} open deficiency(ies) past its planned completion`,
      explanation:
        `Commissioning system ${s.systemCode} "${s.name}" was planned complete on ${s.plannedCompletionDate} and is still ${s.status} ` +
        `with ${s.openDeficiencyCount} open deficiency(ies). A system cannot be turned over while deficiencies are open without the ` +
        `owner accepting them, and deficiencies that outlive the planned completion date are the ones that end up conceded at handover ` +
        `because the programme has run out rather than because anybody decided they were acceptable.`,
      key: s.id,
      evidence: {
        systemId: s.id,
        systemCode: s.systemCode,
        status: s.status,
        plannedCompletionDate: s.plannedCompletionDate,
        openDeficiencyCount: s.openDeficiencyCount,
      },
    });
    outcome.raised += 1;
    outcome.byDetector[QUALITY_DETECTORS.systemDeficienciesOverdue] += 1;
  }
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

/**
 * Run every quality detector over one project. Idempotent: repeated calls
 * raise nothing new while the underlying condition is unchanged.
 */
export async function sweepQuality(
  db: Db,
  companyId: string,
  projectId: string,
  actorId: string | null,
  asOf: string = todayISO(),
): Promise<SweepOutcome> {
  const outcome = emptyOutcome();
  await sweepHoldPoints(db, companyId, projectId, actorId, asOf, outcome);
  await sweepNcrs(db, companyId, projectId, actorId, asOf, outcome);
  await sweepTurnover(db, companyId, projectId, actorId, outcome);
  await sweepSystems(db, companyId, projectId, actorId, asOf, outcome);
  return outcome;
}
