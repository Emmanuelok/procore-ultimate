/**
 * Land & resettlement scheduled detectors.
 *
 * Everything in this file used to run lazily inside a GET handler. It does
 * not any more: reads are pure, these run on the platform scheduler (and can
 * be triggered on demand at POST /projects/:id/land/detectors/run), each pass
 * takes a per-(company, project, detector) advisory lock, and every finding
 * is fingerprinted so a second pass over unchanged data raises nothing.
 *
 * Detector families here:
 *
 *   · GRIEVANCE SLA + ESCALATION LADDER (#572) — a missed clock both raises a
 *     finding and MOVES THE CASE UP THE LADDER, assigning it to the officer
 *     the project has configured for that tier. An escalation that only
 *     produces a dashboard number is not an escalation.
 *   · GRIEVANCE HOTSPOTS (#574) — three complaints of one category at one
 *     location inside a month is a control failure, not three grievances.
 *   · IFC PS5 / ESS5 CONFORMANCE (#558-560) — the four hard rules, each
 *     citing the paragraph it rests on.
 *   · REPLACEMENT-COST SHORTFALL (#550) — compensation below full
 *     replacement cost, which is the finding that reopens a closed RAP.
 *   · CHANCE FINDS (PS8 para 16) — a find whose work stoppage has not been
 *     released and whose authority has not been notified.
 */

import type { FastifyInstance } from "fastify";
import { and, eq, inArray, isNotNull, ne } from "drizzle-orm";
import {
  affectedPersons,
  chanceFinds,
  engagements,
  grievances,
  landParcels,
  obligations,
  projects,
  replacementCostStudies,
  scheduleTasks,
} from "@constructos/db";
import { appendLedger } from "../../lib/ledger.js";
import { forEachCompany } from "../../lib/scheduler.js";
import type { Db } from "../../lib/db.js";
import { todayISO } from "../field/dates.js";
import {
  GRIEVANCE_SETTLED_STATUSES,
  GRIEVANCE_SLA,
  LIVELIHOOD_REQUIRED_DISPLACEMENT,
  PHYSICAL_DISPLACEMENT,
} from "./reference.js";
import {
  detectHotspots,
  ladderDecision,
  GRIEVANCE_TIER_LABELS,
  HOTSPOT_MIN_COUNT,
  HOTSPOT_WINDOW_DAYS,
  type LadderGrievance,
} from "./grievance-engine.js";
import {
  detectCutOffNotDisclosed,
  detectDisplacementBeforeCompensation,
  detectLivelihoodNotRestored,
  detectVulnerableWithoutEnhancement,
  type Ps5Pap,
  type Ps5Parcel,
  type Ps5Task,
} from "./ps5.js";
import {
  emptySweep,
  mergeSweeps,
  raiseSignalOnce,
  reconcileSignals,
  withDetectorLock,
  type SweepResult,
} from "./signals.js";
import { sweepConsent } from "./consent-service.js";

/* ------------------------------------------------------------------ */
/* Project settings: who each escalation tier goes to                  */
/* ------------------------------------------------------------------ */

export interface GrmEscalationConfig {
  tier1UserId: string | null;
  tier2UserId: string | null;
  tier3UserId: string | null;
}

export const EMPTY_GRM_CONFIG: GrmEscalationConfig = {
  tier1UserId: null,
  tier2UserId: null,
  tier3UserId: null,
};

export function readGrmConfig(settings: unknown): GrmEscalationConfig {
  const raw = (settings as Record<string, unknown> | null)?.["grievanceEscalation"];
  if (typeof raw !== "object" || raw === null) return EMPTY_GRM_CONFIG;
  const obj = raw as Record<string, unknown>;
  const pick = (k: string): string | null => (typeof obj[k] === "string" ? (obj[k] as string) : null);
  return {
    tier1UserId: pick("tier1UserId"),
    tier2UserId: pick("tier2UserId"),
    tier3UserId: pick("tier3UserId"),
  };
}

function assigneeForTier(config: GrmEscalationConfig, tier: number): string | null {
  if (tier >= 3) return config.tier3UserId ?? config.tier2UserId ?? config.tier1UserId;
  if (tier === 2) return config.tier2UserId ?? config.tier1UserId;
  if (tier === 1) return config.tier1UserId;
  return null;
}

/* ------------------------------------------------------------------ */
/* Grievance SLA, ladder and hotspots                                  */
/* ------------------------------------------------------------------ */

export async function sweepGrievances(
  db: Db,
  companyId: string,
  projectId: string,
  today = todayISO(),
): Promise<SweepResult> {
  return withDetectorLock(db, companyId, projectId, "grievances", async (tx) => {
    const result = emptySweep();
    const rows = await tx
      .select()
      .from(grievances)
      .where(and(eq(grievances.companyId, companyId), eq(grievances.projectId, projectId)));
    if (rows.length === 0) return result;

    const projectRow = (
      await tx
        .select({ settings: projects.settings })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1)
    )[0];
    const config = readGrmConfig(projectRow?.settings ?? null);

    const open = rows.filter((g) => !(GRIEVANCE_SETTLED_STATUSES as readonly string[]).includes(g.status));
    const breachKeys = new Set<string>();

    for (const g of open) {
      const rule = GRIEVANCE_SLA[g.severity as keyof typeof GRIEVANCE_SLA];
      const ladder: LadderGrievance = {
        id: g.id,
        number: g.number,
        severity: g.severity,
        status: g.status,
        receivedAt: g.receivedAt,
        acknowledgeDueAt: g.acknowledgeDueAt,
        resolveDueAt: g.resolveDueAt,
        acknowledgedAt: g.acknowledgedAt,
        escalationTier: g.escalationTier,
        category: g.category,
        locationId: g.locationId,
      };
      const decision = ladderDecision(ladder, today, rule?.resolveDays ?? 30);
      if (decision) {
        const assignee = assigneeForTier(config, decision.toTier);
        const now = new Date().toISOString();
        const history = [
          ...(g.escalationHistory as unknown[]),
          {
            at: now,
            fromTier: decision.fromTier,
            toTier: decision.toTier,
            reason: decision.reason,
            breach: decision.breach,
            automatic: true,
            assigneeId: assignee,
          },
        ];
        // Guarded on the tier we read, so two runners cannot double-escalate.
        const updated = await tx
          .update(grievances)
          .set({
            escalationTier: decision.toTier,
            escalatedAt: now,
            escalationHistory: history,
            status: g.status === "escalated" ? g.status : "escalated",
            assigneeId: assignee ?? g.assigneeId,
            updatedAt: now,
          })
          .where(
            and(eq(grievances.id, g.id), eq(grievances.escalationTier, decision.fromTier)),
          )
          .returning({ id: grievances.id });
        if (updated.length > 0) {
          await appendLedger(tx, {
            companyId,
            actorId: null,
            action: "state_change",
            objectType: "grievance",
            objectId: g.id,
            projectId,
            payload: {
              event: "escalated_automatically",
              number: g.number,
              fromTier: decision.fromTier,
              toTier: decision.toTier,
              tierLabel: GRIEVANCE_TIER_LABELS[decision.toTier],
              breach: decision.breach,
              overdueDays: decision.overdueDays,
              reason: decision.reason,
              assigneeId: assignee,
              assigneeConfigured: assignee != null,
            },
            storePayload: true,
          });
        }
      }

      // SLA breach finding — the resolution clock only.
      if (g.resolveDueAt != null && g.resolveDueAt < today) {
        breachKeys.add(g.id);
        if (g.obligationId) {
          await tx
            .update(obligations)
            .set({ status: "breached" })
            .where(and(eq(obligations.id, g.obligationId), eq(obligations.status, "open")));
        }
        const overdueBy = Math.round(
          (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${g.resolveDueAt}T00:00:00Z`)) /
            86_400_000,
        );
        const raise = await raiseSignalOnce(tx, {
          companyId,
          projectId,
          detector: "grievance_sla_breach",
          key: g.id,
          severity: g.severity === "critical" ? "critical" : "high",
          confidence: 1,
          title: `Grievance GRV-${g.number} past its resolution SLA by ${overdueBy} day(s)`,
          explanation:
            `Grievance GRV-${g.number} (${g.category}, severity ${g.severity}) was received on ` +
            `${g.receivedAt} with a resolution deadline of ${g.resolveDueAt} under the ` +
            `${rule ? `${rule.resolveDays}-day` : "published"} grievance redress standard, and ` +
            `remains ${g.status}. An unresolved grievance past its published SLA is the ` +
            `clearest single evidence that the grievance mechanism is not functioning — a ` +
            `reportable finding under IFC PS1 / ESS10 and a common trigger for community ` +
            `disruption of the works.`,
          subjectType: "grievance",
          subjectId: g.id,
          evidenceRefs: {
            grievanceId: g.id,
            number: g.number,
            resolveDueAt: g.resolveDueAt,
            severity: g.severity,
            escalationTier: g.escalationTier,
          },
          ledger: { objectType: "grievance", objectId: g.id, payload: { number: g.number } },
        });
        if (raise.raised) result.raised += 1;
        else result.repeat += 1;
      }
    }

    result.closed += await reconcileSignals(
      tx,
      companyId,
      projectId,
      "grievance_sla_breach",
      breachKeys,
      "The grievance was resolved, rejected or closed, so the SLA breach no longer stands open.",
    );

    /* Hotspots — over open AND settled cases: a cluster that was all closed
       last week is still the cluster that tells you where the problem is. */
    const hotspots = detectHotspots(
      rows.map((g) => ({
        id: g.id,
        number: g.number,
        severity: g.severity,
        status: g.status,
        receivedAt: g.receivedAt,
        acknowledgeDueAt: g.acknowledgeDueAt,
        resolveDueAt: g.resolveDueAt,
        acknowledgedAt: g.acknowledgedAt,
        escalationTier: g.escalationTier,
        category: g.category,
        locationId: g.locationId,
      })),
    );
    const hotspotKeys = new Set<string>();
    for (const cluster of hotspots) {
      const key = `${cluster.locationId}:${cluster.category}:${cluster.windowStart}`;
      hotspotKeys.add(key);
      const raise = await raiseSignalOnce(tx, {
        companyId,
        projectId,
        detector: "grievance_hotspot",
        key,
        severity: cluster.count >= HOTSPOT_MIN_COUNT * 2 ? "high" : "medium",
        confidence: 0.9,
        title: `Grievance hotspot — ${cluster.count} ${cluster.category} complaints at one location`,
        explanation:
          `${cluster.count} grievances in the "${cluster.category}" category were received at ` +
          `the same location between ${cluster.windowStart} and ${cluster.windowEnd} — at least ` +
          `${HOTSPOT_MIN_COUNT} inside a ${HOTSPOT_WINDOW_DAYS}-day window. Individually these ` +
          `are complaints; together they are a control failure at a specific place, and they ` +
          `are how community disruption of the works starts. Severity mix: ` +
          `${Object.entries(cluster.severityMix)
            .map(([k, v]) => `${v} ${k}`)
            .join(", ")}.`,
        subjectType: "location",
        subjectId: cluster.locationId,
        evidenceRefs: {
          locationId: cluster.locationId,
          category: cluster.category,
          count: cluster.count,
          windowStart: cluster.windowStart,
          windowEnd: cluster.windowEnd,
          grievanceIds: cluster.grievanceIds,
        },
        ledger: { objectType: "location", objectId: cluster.locationId },
      });
      if (raise.raised) result.raised += 1;
      else result.repeat += 1;
    }
    result.closed += await reconcileSignals(
      tx,
      companyId,
      projectId,
      "grievance_hotspot",
      hotspotKeys,
      "The cluster no longer meets the hotspot threshold in its window.",
    );

    return result;
  });
}

/* ------------------------------------------------------------------ */
/* IFC PS5 conformance                                                 */
/* ------------------------------------------------------------------ */

export async function sweepPs5(
  db: Db,
  companyId: string,
  projectId: string,
  today = todayISO(),
): Promise<SweepResult> {
  return withDetectorLock(db, companyId, projectId, "ps5", async (tx) => {
    const result = emptySweep();
    const parcelRows = await tx
      .select()
      .from(landParcels)
      .where(and(eq(landParcels.companyId, companyId), eq(landParcels.projectId, projectId)));
    const papRows = await tx
      .select()
      .from(affectedPersons)
      .where(
        and(eq(affectedPersons.companyId, companyId), eq(affectedPersons.projectId, projectId)),
      );
    const projectRow0 = (
      await tx
        .select({ settings: projects.settings })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1)
    )[0];
    const hasCutOff =
      typeof (projectRow0?.settings as Record<string, unknown> | null)?.["landCutOffDate"] ===
      "string";
    /*
     * A declared but undisclosed cut-off is a finding in its own right — it is
     * the moment the entitlement population is frozen, and it is exactly the
     * moment before the census exists. Skipping the whole PS5 pass because the
     * registers are still empty would silence the one detector that matters
     * most on day one.
     */
    if (parcelRows.length === 0 && papRows.length === 0 && !hasCutOff) return result;

    const taskIds = [...new Set(parcelRows.flatMap((p) => p.blockingTaskIds ?? []))];
    const taskRows = taskIds.length
      ? await tx
          .select({
            id: scheduleTasks.id,
            name: scheduleTasks.name,
            actualStart: scheduleTasks.actualStart,
          })
          .from(scheduleTasks)
          .where(and(inArray(scheduleTasks.id, taskIds), eq(scheduleTasks.projectId, projectId)))
      : [];
    const tasksById = new Map<string, Ps5Task>(taskRows.map((t) => [t.id, t]));

    const parcels: Ps5Parcel[] = parcelRows.map((p) => ({
      id: p.id,
      reference: p.reference,
      status: p.status,
      compensationPaidAt: p.compensationPaidAt,
      acquisitionBasis: p.acquisitionBasis,
      tenureType: p.tenureType,
      blockingTaskIds: p.blockingTaskIds ?? [],
    }));
    const paps: Ps5Pap[] = papRows.map((p) => ({
      id: p.id,
      reference: p.reference,
      householdHead: p.householdHead,
      status: p.status,
      displacementType: p.displacementType,
      vulnerabilities: p.vulnerabilities ?? [],
      entitlements: (p.entitlements as unknown[]) ?? [],
      compensationPaidAt: p.compensationPaidAt,
      livelihoodRestoredAt: p.livelihoodRestoredAt,
    }));

    const settings = (projectRow0?.settings ?? {}) as Record<string, unknown>;
    const cutOffDate = typeof settings["landCutOffDate"] === "string" ? settings["landCutOffDate"] : null;
    const declaredAt =
      typeof settings["landCutOffDeclaredAt"] === "string"
        ? (settings["landCutOffDeclaredAt"] as string)
        : null;
    const engagementRows = cutOffDate
      ? await tx
          .select({
            id: engagements.id,
            kind: engagements.kind,
            engagementDate: engagements.engagementDate,
          })
          .from(engagements)
          .where(and(eq(engagements.companyId, companyId), eq(engagements.projectId, projectId)))
      : [];

    const findings = [
      ...detectDisplacementBeforeCompensation({ parcels, paps, tasksById }),
      ...detectVulnerableWithoutEnhancement(paps),
      ...detectCutOffNotDisclosed({
        projectId,
        cutOffDate,
        declaredAt,
        engagements: engagementRows,
      }),
      ...detectLivelihoodNotRestored({
        paps,
        physicalDisplacementTypes: PHYSICAL_DISPLACEMENT,
        livelihoodRequiredTypes: LIVELIHOOD_REQUIRED_DISPLACEMENT,
        today,
      }),
    ];

    const keysByDetector = new Map<string, Set<string>>();
    for (const detector of [
      "displacement_before_compensation",
      "vulnerable_household_without_enhanced_entitlement",
      "cut_off_not_disclosed",
      "livelihood_not_restored",
    ] as const) {
      keysByDetector.set(detector, new Set());
    }

    for (const f of findings) {
      keysByDetector.get(f.detector)!.add(f.key);
      const raise = await raiseSignalOnce(tx, {
        companyId,
        projectId,
        detector: f.detector,
        key: f.key,
        severity: f.severity,
        confidence: 1,
        title: f.title,
        explanation: f.explanation,
        subjectType: f.subjectType,
        subjectId: f.subjectId,
        evidenceRefs: f.evidenceRefs,
        ledger: { objectType: f.subjectType, objectId: f.subjectId },
      });
      if (raise.raised) result.raised += 1;
      else result.repeat += 1;
    }

    for (const [detector, keys] of keysByDetector) {
      result.closed += await reconcileSignals(
        tx,
        companyId,
        projectId,
        detector as
          | "displacement_before_compensation"
          | "vulnerable_household_without_enhanced_entitlement"
          | "cut_off_not_disclosed"
          | "livelihood_not_restored",
        keys,
        "The condition behind this IFC PS5 finding no longer holds on the register.",
      );
    }
    return result;
  });
}

/* ------------------------------------------------------------------ */
/* Replacement-cost shortfall                                          */
/* ------------------------------------------------------------------ */

export async function sweepReplacementCost(
  db: Db,
  companyId: string,
  projectId: string,
): Promise<SweepResult> {
  return withDetectorLock(db, companyId, projectId, "replacement", async (tx) => {
    const result = emptySweep();
    const rows = await tx
      .select()
      .from(replacementCostStudies)
      .where(
        and(
          eq(replacementCostStudies.companyId, companyId),
          eq(replacementCostStudies.projectId, projectId),
          eq(replacementCostStudies.verdict, "shortfall"),
        ),
      );
    const keys = new Set<string>();
    for (const study of rows) {
      keys.add(study.id);
      const raise = await raiseSignalOnce(tx, {
        companyId,
        projectId,
        detector: "replacement_cost_shortfall",
        key: study.id,
        severity: "high",
        confidence: 1,
        title: `Compensation below full replacement cost — ${study.description.slice(0, 80)}`,
        explanation:
          `A ${study.method} valuation dated ${study.surveyDate} puts the full replacement cost ` +
          `of this ${study.assetType} at ${study.replacementCost} ${study.currency}, against ` +
          `compensation of ${study.compensationOffered ?? "nil"} ${study.currency} — a shortfall ` +
          `of ${study.shortfall ?? 0} ${study.currency}. IFC PS5 para 27 requires compensation ` +
          `at FULL replacement cost: market value of an equivalent asset with no deduction for ` +
          `depreciation, plus the transaction costs the household must bear. A shortfall here ` +
          `is the finding that reopens a closed Resettlement Action Plan, and it is normally ` +
          `caused by paying a depreciated government schedule rate.` +
          (study.valuerIndependent === 1
            ? ` The valuation was produced by an independent valuer (${study.valuerName ?? "unnamed"}).`
            : ` The valuation was NOT produced by an independent valuer, which weakens it as ` +
              `evidence in both directions.`),
        subjectType: "replacement_cost_study",
        subjectId: study.id,
        evidenceRefs: {
          studyId: study.id,
          parcelId: study.parcelId,
          papId: study.papId,
          replacementCost: study.replacementCost,
          compensationOffered: study.compensationOffered,
          shortfall: study.shortfall,
          currency: study.currency,
          citation: "IFC PS5 para 27",
        },
        ledger: { objectType: "replacement_cost_study", objectId: study.id },
      });
      if (raise.raised) result.raised += 1;
      else result.repeat += 1;
    }
    result.closed += await reconcileSignals(
      tx,
      companyId,
      projectId,
      "replacement_cost_shortfall",
      keys,
      "The study was re-verified as adequate or superseded.",
    );
    return result;
  });
}

/* ------------------------------------------------------------------ */
/* Chance finds (PS8 para 16)                                          */
/* ------------------------------------------------------------------ */

export async function sweepChanceFinds(
  db: Db,
  companyId: string,
  projectId: string,
): Promise<SweepResult> {
  return withDetectorLock(db, companyId, projectId, "chance-finds", async (tx) => {
    const result = emptySweep();
    const rows = await tx
      .select()
      .from(chanceFinds)
      .where(
        and(
          eq(chanceFinds.companyId, companyId),
          eq(chanceFinds.projectId, projectId),
          ne(chanceFinds.status, "released"),
        ),
      );
    const keys = new Set<string>();
    for (const find of rows) {
      if (find.authorityNotifiedAt) continue;
      keys.add(find.id);
      const raise = await raiseSignalOnce(tx, {
        companyId,
        projectId,
        detector: "chance_find_unreleased",
        key: find.id,
        severity: "high",
        confidence: 1,
        title: `Chance find CF-${find.number} not notified to the authority`,
        explanation:
          `Chance find CF-${find.number}, discovered ${find.discoveredAt}, is ${find.status} ` +
          `with no record of the competent authority having been notified. IFC PS8 para 16 ` +
          `requires the works in the affected area to stop and the relevant authority to be ` +
          `notified before they resume. An unreported find is a criminal offence in most ` +
          `jurisdictions and destroys the evidence that would have justified the stoppage.` +
          (find.workStoppedAt
            ? ` Work was stopped on ${find.workStoppedAt}.`
            : ` No work stoppage has been recorded either.`),
        subjectType: "chance_find",
        subjectId: find.id,
        evidenceRefs: {
          chanceFindId: find.id,
          number: find.number,
          discoveredAt: find.discoveredAt,
          status: find.status,
          workStoppedAt: find.workStoppedAt,
          citation: "IFC PS8 para 16",
        },
        ledger: { objectType: "chance_find", objectId: find.id },
      });
      if (raise.raised) result.raised += 1;
      else result.repeat += 1;
    }
    result.closed += await reconcileSignals(
      tx,
      companyId,
      projectId,
      "chance_find_unreleased",
      keys,
      "The authority was notified, or the find was released.",
    );
    return result;
  });
}

/* ------------------------------------------------------------------ */
/* Orchestration                                                       */
/* ------------------------------------------------------------------ */

/** Project ids in this company that hold any land-module record at all. */
async function landProjectIds(db: Db, companyId: string): Promise<string[]> {
  const ids = new Set<string>();
  const add = (rows: { projectId: string }[]) => rows.forEach((r) => ids.add(r.projectId));
  add(
    await db
      .selectDistinct({ projectId: landParcels.projectId })
      .from(landParcels)
      .where(eq(landParcels.companyId, companyId)),
  );
  add(
    await db
      .selectDistinct({ projectId: affectedPersons.projectId })
      .from(affectedPersons)
      .where(eq(affectedPersons.companyId, companyId)),
  );
  add(
    await db
      .selectDistinct({ projectId: grievances.projectId })
      .from(grievances)
      .where(eq(grievances.companyId, companyId)),
  );
  add(
    await db
      .selectDistinct({ projectId: chanceFinds.projectId })
      .from(chanceFinds)
      .where(eq(chanceFinds.companyId, companyId)),
  );
  return [...ids];
}

/** Every land detector for one project, in one pass. */
export async function runLandDetectors(
  db: Db,
  companyId: string,
  projectId: string,
  today = todayISO(),
): Promise<SweepResult> {
  return mergeSweeps(
    await sweepGrievances(db, companyId, projectId, today),
    await sweepPs5(db, companyId, projectId, today),
    await sweepReplacementCost(db, companyId, projectId),
    await sweepChanceFinds(db, companyId, projectId),
    await sweepConsent(db, companyId, projectId, today),
  );
}

export async function runLandDetectorsForCompany(
  db: Db,
  companyId: string,
  today = todayISO(),
): Promise<{ projects: number; result: SweepResult }> {
  const ids = await landProjectIds(db, companyId);
  let result = emptySweep();
  for (const projectId of ids) {
    result = mergeSweeps(result, await runLandDetectors(db, companyId, projectId, today));
  }
  return { projects: ids.length, result };
}

export function registerLandJobs(app: FastifyInstance): void {
  app.scheduler.register({
    name: "land.detectors",
    description:
      "Grievance SLA breaches and automatic escalation, grievance hotspots, IFC PS5 / ESS5 " +
      "conformance, replacement-cost shortfalls, unnotified chance finds and the " +
      "consent-to-programme dependency — over every project holding land records",
    everyMs: 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) =>
      forEachCompany(db, (companyId) =>
        runLandDetectorsForCompany(db, companyId, now.toISOString().slice(0, 10)),
      ),
  });
}

/** Obligations still open on grievances that were settled — used by tests. */
export async function openGrievanceObligations(
  db: Db,
  companyId: string,
  projectId: string,
): Promise<number> {
  const rows = await db
    .select({ id: grievances.id })
    .from(grievances)
    .where(
      and(
        eq(grievances.companyId, companyId),
        eq(grievances.projectId, projectId),
        isNotNull(grievances.obligationId),
      ),
    );
  return rows.length;
}
