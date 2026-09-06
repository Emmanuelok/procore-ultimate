/**
 * Consent-to-programme service (#591) — loads the two blocking registers
 * (land parcels and statutory permits), runs the pure engine in consent.ts,
 * and raises / auto-resolves the three consent detectors.
 *
 * It lives in the land module because that is where the engine lives, but it
 * is deliberately register-agnostic: it reads parcels AND permits, so the
 * unified consent view (`GET /projects/:id/land/consent`) and the land
 * schedule-risk view answer for both registers at once. The jurisdiction
 * module keeps its own permit-only schedule-risk read for the permits
 * workspace; both are now pure, and the FINDINGS come from here alone, so
 * the two views can never disagree about what has been raised.
 *
 * Detectors raised here:
 *
 *   land_blocks_programme            — an unacquired parcel blocks a task
 *                                      starting inside the signal horizon.
 *   permit_blocks_programme          — same, for an ungranted consent.
 *   works_started_on_unconsented_land — CRITICAL: the task has an actual
 *                                      start while its dependency is still
 *                                      unresolved. This is the one that
 *                                      cannot be fixed by re-planning.
 *
 * All three reconcile: acquire the parcel, grant the permit, or move the
 * task out of the horizon, and the signal closes itself with `autoClosedAt`
 * set rather than sitting open forever as noise.
 */

import { and, eq, inArray } from "drizzle-orm";
import { landParcels, ledgerEntries, permits, scheduleTasks } from "@constructos/db";
import type { Db } from "../../lib/db.js";
import { todayISO } from "../field/dates.js";
import {
  PARCEL_BLOCKING_STATUSES,
  PARCEL_READY_STATUS,
} from "./reference.js";
import {
  buildConsentView,
  type ConsentDependency,
  type ConsentResult,
  type ConsentTask,
  type ObservedDuration,
} from "./consent.js";
import {
  emptySweep,
  raiseSignalOnce,
  reconcileSignals,
  withDetectorLock,
  type SweepResult,
} from "./signals.js";

/** Tasks starting inside this horizon raise a signal, not just a row. */
export const SIGNAL_HORIZON_DAYS = 30;
/** Default reporting horizon for the workspace view. */
export const DEFAULT_HORIZON_DAYS = 90;

const PERMIT_BLOCKING: readonly string[] = [
  "not_started",
  "applied",
  "in_review",
  "refused",
  "expired",
];

/* ------------------------------------------------------------------ */
/* Observed durations from the ledger                                  */
/* ------------------------------------------------------------------ */

interface StatePayload {
  from?: unknown;
  to?: unknown;
}

/**
 * Median historical resolution durations, reconstructed from the ledger.
 *
 * Every parcel and permit state change is ledgered with `{from, to}` and a
 * timestamp, so the elapsed time from entering a state to reaching the
 * resolved state is recoverable without adding per-status timestamp columns.
 * The scan is bounded to the most recent `limit` state changes for the two
 * object types in this company — a project with no history simply gets an
 * empty set and the engine falls back to its documented defaults, which it
 * says so on every row it uses them for.
 */
export async function loadObservedDurations(
  db: Db,
  companyId: string,
  limit = 1000,
): Promise<ObservedDuration[]> {
  const rows = await db
    .select({
      objectType: ledgerEntries.objectType,
      objectId: ledgerEntries.objectId,
      payload: ledgerEntries.payload,
      at: ledgerEntries.at,
    })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.companyId, companyId),
        eq(ledgerEntries.action, "state_change"),
        inArray(ledgerEntries.objectType, ["land_parcel", "permit"]),
      ),
    )
    .orderBy(ledgerEntries.seq)
    .limit(limit);

  // objectId → ordered [{ state, at }]
  const byObject = new Map<string, { kind: "parcel" | "permit"; at: string; to: string }[]>();
  for (const r of rows) {
    const payload = (r.payload ?? null) as StatePayload | null;
    const to = typeof payload?.to === "string" ? payload.to : null;
    if (!to) continue;
    const kind = r.objectType === "land_parcel" ? "parcel" : "permit";
    const list = byObject.get(r.objectId) ?? [];
    list.push({ kind, at: r.at, to });
    byObject.set(r.objectId, list);
  }

  const resolvedState = { parcel: PARCEL_READY_STATUS as string, permit: "granted" };
  const out: ObservedDuration[] = [];
  for (const events of byObject.values()) {
    events.sort((a, b) => a.at.localeCompare(b.at));
    const kind = events[0]!.kind;
    const resolvedIdx = events.findIndex((e) => e.to === resolvedState[kind]);
    if (resolvedIdx <= 0) continue;
    const resolvedAt = Date.parse(events[resolvedIdx]!.at);
    for (let i = 0; i < resolvedIdx; i += 1) {
      const days = Math.round((resolvedAt - Date.parse(events[i]!.at)) / 86_400_000);
      if (days < 0) continue;
      out.push({ kind, status: events[i]!.to, days });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Loading                                                             */
/* ------------------------------------------------------------------ */

export interface ConsentLoad {
  view: ConsentResult;
  /** every dependency considered, resolved ones included, for the register */
  dependencies: ConsentDependency[];
}

export async function loadConsentView(
  db: Db,
  companyId: string,
  projectId: string,
  opts?: { horizonDays?: number; today?: string; withObservations?: boolean },
): Promise<ConsentLoad> {
  const today = opts?.today ?? todayISO();
  const horizonDays = opts?.horizonDays ?? DEFAULT_HORIZON_DAYS;

  const parcelRows = await db
    .select()
    .from(landParcels)
    .where(and(eq(landParcels.companyId, companyId), eq(landParcels.projectId, projectId)));
  const permitRows = await db
    .select()
    .from(permits)
    .where(and(eq(permits.companyId, companyId), eq(permits.projectId, projectId)));

  const dependencies: ConsentDependency[] = [];
  for (const p of parcelRows) {
    if ((p.blockingTaskIds ?? []).length === 0) continue;
    dependencies.push({
      kind: "parcel",
      id: p.id,
      reference: p.reference,
      label: `Parcel ${p.reference}`,
      status: p.status,
      resolved: !(PARCEL_BLOCKING_STATUSES as readonly string[]).includes(p.status),
      taskIds: p.blockingTaskIds ?? [],
      detail: {
        tenureType: p.tenureType,
        ownerName: p.ownerName,
        compensationPaidAt: p.compensationPaidAt,
        acquisitionBasis: p.acquisitionBasis,
      },
    });
  }
  for (const p of permitRows) {
    if ((p.blockingTaskIds ?? []).length === 0) continue;
    dependencies.push({
      kind: "permit",
      id: p.id,
      reference: `PRM-${p.number}`,
      label: p.title,
      status: p.status,
      resolved: !PERMIT_BLOCKING.includes(p.status),
      taskIds: p.blockingTaskIds ?? [],
      detail: {
        kind: p.kind,
        authority: p.authority,
        dueAt: p.dueAt,
        expiresAt: p.expiresAt,
        number: p.number,
      },
    });
  }

  const taskIds = [...new Set(dependencies.flatMap((d) => [...d.taskIds]))];
  const taskRows = taskIds.length
    ? await db
        .select({
          id: scheduleTasks.id,
          name: scheduleTasks.name,
          wbsCode: scheduleTasks.wbsCode,
          startDate: scheduleTasks.startDate,
          constraintDate: scheduleTasks.constraintDate,
          actualStart: scheduleTasks.actualStart,
          totalFloat: scheduleTasks.totalFloat,
          isCritical: scheduleTasks.isCritical,
        })
        .from(scheduleTasks)
        .where(and(inArray(scheduleTasks.id, taskIds), eq(scheduleTasks.projectId, projectId)))
    : [];

  const tasks: ConsentTask[] = taskRows.map((t) => ({
    id: t.id,
    name: t.name,
    wbsCode: t.wbsCode,
    startDate: t.startDate ?? t.constraintDate,
    actualStart: t.actualStart,
    totalFloat: t.totalFloat,
    isCritical: t.isCritical === 1,
  }));

  const observations = opts?.withObservations
    ? await loadObservedDurations(db, companyId)
    : [];

  return {
    view: buildConsentView({ today, horizonDays, tasks, dependencies, observations }),
    dependencies,
  };
}

/* ------------------------------------------------------------------ */
/* Sweep                                                               */
/* ------------------------------------------------------------------ */

/**
 * Raise (and auto-resolve) the consent detectors for one project.
 *
 * Findings are keyed on `(dependency, task)` so a parcel blocking four tasks
 * produces four findings that clear independently — which is what a
 * programme director acts on. The signal horizon is deliberately shorter
 * than the reporting horizon: everything inside 90 days is worth showing,
 * only what is inside 30 days is worth interrupting somebody about.
 */
export async function sweepConsent(
  db: Db,
  companyId: string,
  projectId: string,
  today?: string,
): Promise<SweepResult> {
  return withDetectorLock(db, companyId, projectId, "consent", async (tx) => {
    const { view } = await loadConsentView(tx, companyId, projectId, {
      horizonDays: SIGNAL_HORIZON_DAYS,
      today,
      withObservations: true,
    });
    const result = emptySweep();
    const landKeys = new Set<string>();
    const permitKeys = new Set<string>();
    const startedKeys = new Set<string>();

    for (const task of view.tasks) {
      for (const dep of task.dependencies) {
        const key = `${dep.id}:${task.taskId}`;
        const detector =
          dep.kind === "parcel" ? "land_blocks_programme" : "permit_blocks_programme";
        (dep.kind === "parcel" ? landKeys : permitKeys).add(key);
        const when =
          task.daysUntilStart == null
            ? "has no scheduled start"
            : task.daysUntilStart < 0
              ? `started ${Math.abs(task.daysUntilStart)} day(s) ago`
              : `starts in ${task.daysUntilStart} day(s)`;
        const raise = await raiseSignalOnce(tx, {
          companyId,
          projectId,
          detector,
          key,
          severity: "high",
          confidence: 1,
          title:
            dep.kind === "parcel"
              ? `Land not acquired blocks "${task.taskName}" — parcel ${dep.reference}`
              : `Consent not in place for "${task.taskName}" — ${dep.label}`,
          explanation:
            (dep.kind === "parcel"
              ? `Parcel ${dep.reference} is ${dep.status} and has not been acquired, yet it ` +
                `blocks schedule task "${task.taskName}", which ${when} ` +
                `(planned start ${task.plannedStart ?? "unset"}). Mobilising onto land the ` +
                `project does not hold exposes it to trespass, injunction and lender-standard ` +
                `non-compliance, and is one of the most common root causes of prolongation ` +
                `claims on internationally financed infrastructure.`
              : `${dep.label} (${dep.reference}, ${dep.detail["authority"] ?? "authority not " +
                  "recorded"}) is ${dep.status} and blocks schedule task "${task.taskName}", ` +
                `which ${when} (planned start ${task.plannedStart ?? "unset"}). A ` +
                `consent-to-programme dependency with no grant on file is a delay already in ` +
                `motion: either the start moves or the work proceeds unlawfully.`) +
            ` ${task.basis}`,
          subjectType: dep.kind === "parcel" ? "land_parcel" : "permit",
          subjectId: dep.id,
          evidenceRefs: {
            [dep.kind === "parcel" ? "parcelId" : "permitId"]: dep.id,
            taskId: task.taskId,
            reference: dep.reference,
            status: dep.status,
            plannedStart: task.plannedStart,
            daysAtRisk: dep.daysAtRisk,
            expectedResolutionDate: dep.expectedResolutionDate,
            estimateSource: dep.estimateSource,
            isCritical: task.isCritical,
            slipContribution: task.slipContribution,
          },
          ledger: {
            objectType: dep.kind === "parcel" ? "land_parcel" : "permit",
            objectId: dep.id,
            payload: { taskId: task.taskId, status: dep.status },
          },
        });
        if (raise.raised) result.raised += 1;
        else result.repeat += 1;

        if (task.startedUnconsented) {
          startedKeys.add(key);
          const critical = await raiseSignalOnce(tx, {
            companyId,
            projectId,
            detector: "works_started_on_unconsented_land",
            key,
            severity: "critical",
            confidence: 1,
            title: `Works started without consent — "${task.taskName}" (${dep.reference})`,
            explanation:
              `Schedule task "${task.taskName}" has an actual start of ${task.actualStart}, ` +
              `while ${dep.kind === "parcel" ? "parcel" : "permit"} ${dep.reference} is still ` +
              `${dep.status}. The works are physically underway on land the project does not ` +
              `hold, or under a consent it has not been granted. Unlike a forecast dependency, ` +
              `this one cannot be fixed by re-planning: it has already happened, and it is the ` +
              `finding that triggers a stop notice, an injunction or a lender's ` +
              `non-compliance escalation.`,
            subjectType: "schedule_task",
            subjectId: task.taskId,
            evidenceRefs: {
              taskId: task.taskId,
              actualStart: task.actualStart,
              dependencyKind: dep.kind,
              dependencyId: dep.id,
              reference: dep.reference,
              status: dep.status,
            },
            ledger: {
              objectType: dep.kind === "parcel" ? "land_parcel" : "permit",
              objectId: dep.id,
              payload: { taskId: task.taskId, actualStart: task.actualStart },
            },
          });
          if (critical.raised) result.raised += 1;
          else result.repeat += 1;
        }
      }
    }

    result.closed += await reconcileSignals(
      tx,
      companyId,
      projectId,
      "land_blocks_programme",
      landKeys,
      "The parcel was acquired, or the blocked task moved out of the signal horizon.",
    );
    result.closed += await reconcileSignals(
      tx,
      companyId,
      projectId,
      "permit_blocks_programme",
      permitKeys,
      "The permit was granted, or the blocked task moved out of the signal horizon.",
    );
    result.closed += await reconcileSignals(
      tx,
      companyId,
      projectId,
      "works_started_on_unconsented_land",
      startedKeys,
      "The dependency was resolved, or the task's actual start was corrected.",
    );
    return result;
  });
}
