/**
 * ESG & environment scheduled detectors.
 *
 * These replace the lazy read-time sweeps that used to run inside
 * `GET /carbon/summary`, `GET /social-value` and friends. The workspaces fire
 * their summary and list requests in parallel, so both requests used to read
 * "no signal yet", both computed the same shortfall, and both inserted one —
 * plus two ledger rows attributed to whoever happened to open the tab.
 *
 * Families here:
 *
 *   · CARBON BUDGET EXCEEDANCE (#495) — keyed on (budget, target), so a
 *     target REVISION re-arms the detector. The previous behaviour keyed on
 *     the budget alone: exceed, raise, revise the target upward, exceed
 *     again — and assurance never heard about the second overrun, while the
 *     first signal sat open describing a budget that was now on track.
 *   · SOCIAL VALUE STATUS AND SHORTFALL (#539-540) — status is partly a
 *     function of the calendar, so a commitment nobody delivered against
 *     must still fall to at_risk and then shortfall on its own.
 *   · ENVIRONMENTAL LIMIT EXCEEDANCE (#505-512) — a reading past its consent
 *     limit, with the limit and its basis cited.
 *   · UNREPORTED REPORTABLE INCIDENT — a reportable environmental incident
 *     whose regulator notification window has passed.
 *   · BIODIVERSITY NET LOSS — post-intervention units below baseline.
 */

import type { FastifyInstance } from "fastify";
import { and, asc, eq, isNull } from "drizzle-orm";
import {
  biodiversityUnits as biodiversityUnitsTable,
  carbonBudgets,
  carbonEntries,
  environmentalIncidents,
  monitoringPoints,
  monitoringReadings,
  socialValueCommitments,
} from "@constructos/db";
import { appendLedger } from "../../lib/ledger.js";
import { forEachCompany } from "../../lib/scheduler.js";
import type { Db } from "../../lib/db.js";
import { todayISO } from "../field/dates.js";
import {
  emptySweep,
  mergeSweeps,
  raiseSignalOnce,
  reconcileSignals,
  withDetectorLock,
  type SweepResult,
} from "../land/signals.js";
import { budgetDrawdown, commitmentStatus, percent, round2, round6 } from "./carbon.js";
import { computeNetGain } from "./environment.js";

/**
 * Statutory notification windows are measured in hours, not days; 24 hours is
 * the common floor across EA/SEPA, EPA and equivalent regimes for a
 * reportable pollution incident.
 */
export const REGULATOR_NOTIFICATION_HOURS = 24;

/* ------------------------------------------------------------------ */
/* Carbon budgets                                                      */
/* ------------------------------------------------------------------ */

/** Σ tCO2e per budget for a project. */
export async function budgetActualsFor(
  db: Db,
  companyId: string,
  projectId: string,
): Promise<Map<string, number>> {
  const rows = await db
    .select({ budgetId: carbonEntries.budgetId, tco2e: carbonEntries.tco2e })
    .from(carbonEntries)
    .where(and(eq(carbonEntries.companyId, companyId), eq(carbonEntries.projectId, projectId)));
  const out = new Map<string, number>();
  for (const r of rows) {
    if (!r.budgetId) continue;
    out.set(r.budgetId, (out.get(r.budgetId) ?? 0) + r.tco2e);
  }
  for (const [k, v] of out) out.set(k, round6(v));
  return out;
}

export async function sweepCarbonBudgets(
  db: Db,
  companyId: string,
  projectId: string,
): Promise<SweepResult> {
  return withDetectorLock(db, companyId, projectId, "carbon-budgets", async (tx) => {
    const result = emptySweep();
    const budgets = await tx
      .select()
      .from(carbonBudgets)
      .where(and(eq(carbonBudgets.companyId, companyId), eq(carbonBudgets.projectId, projectId)));
    if (budgets.length === 0) return result;
    const actuals = await budgetActualsFor(tx, companyId, projectId);
    const keys = new Set<string>();

    for (const b of budgets) {
      const actual = actuals.get(b.id) ?? 0;
      const draw = budgetDrawdown(actual, b.targetTco2e);
      if (draw.status !== "exceeded") continue;
      // Keyed on the TARGET as well as the budget: revising the target is a
      // new fact, and the new overrun of a revised target is a new finding.
      const key = `${b.id}:${b.targetTco2e}`;
      keys.add(key);
      const raise = await raiseSignalOnce(tx, {
        companyId,
        projectId,
        detector: "carbon_budget_exceeded",
        key,
        severity: "medium",
        confidence: 1,
        title: `Carbon budget exceeded — ${b.name} (${draw.drawdownPercent}% of target)`,
        explanation:
          `Entries booked against carbon budget "${b.name}"${b.element ? ` (${b.element})` : ""} ` +
          `total ${round6(actual)} tCO2e against a target of ${b.targetTco2e} tCO2e — an ` +
          `overrun of ${round6(-draw.remaining)} tCO2e (${draw.drawdownPercent}% drawdown). ` +
          `The baseline for this element was ${b.baselineTco2e} tCO2e. Reduction against the ` +
          `target is no longer achievable by omission alone; a design or specification change ` +
          `is required, or the target must be formally revised — and a revision re-arms this ` +
          `detector rather than silencing it.`,
        subjectType: "carbon_budget",
        subjectId: b.id,
        evidenceRefs: {
          budgetId: b.id,
          targetTco2e: b.targetTco2e,
          actualTco2e: round6(actual),
          baselineTco2e: b.baselineTco2e,
        },
        ledger: {
          objectType: "carbon_budget",
          objectId: b.id,
          payload: { status: "exceeded", actualTco2e: round6(actual), targetTco2e: b.targetTco2e },
        },
      });
      if (raise.raised) result.raised += 1;
      else result.repeat += 1;
    }

    result.closed += await reconcileSignals(
      tx,
      companyId,
      projectId,
      "carbon_budget_exceeded",
      keys,
      "The budget is back within its target, or the target was revised and the finding was " +
        "superseded by a fresh assessment against the new target.",
    );
    return result;
  });
}

/* ------------------------------------------------------------------ */
/* Social value                                                        */
/* ------------------------------------------------------------------ */

export async function sweepSocialValue(
  db: Db,
  companyId: string,
  projectId: string,
  today = todayISO(),
): Promise<SweepResult> {
  return withDetectorLock(db, companyId, projectId, "social-value", async (tx) => {
    const result = emptySweep();
    const rows = await tx
      .select()
      .from(socialValueCommitments)
      .where(
        and(
          eq(socialValueCommitments.companyId, companyId),
          eq(socialValueCommitments.projectId, projectId),
        ),
      );
    const keys = new Set<string>();

    for (const c of rows) {
      const next = commitmentStatus(c.deliveredValue, c.targetValue, c.dueDate, today);
      if (next !== c.status) {
        // Guarded on the status we read: two runners cannot both flip it, and
        // the ledger entry only follows an update that actually happened.
        const updated = await tx
          .update(socialValueCommitments)
          .set({ status: next, updatedAt: new Date().toISOString() })
          .where(
            and(eq(socialValueCommitments.id, c.id), eq(socialValueCommitments.status, c.status)),
          )
          .returning({ id: socialValueCommitments.id });
        if (updated.length > 0) {
          await appendLedger(tx, {
            companyId,
            actorId: null,
            action: "state_change",
            objectType: "social_value_commitment",
            objectId: c.id,
            projectId,
            payload: { from: c.status, to: next, deliveredValue: c.deliveredValue },
            storePayload: true,
          });
        }
      }
      if (next !== "shortfall") continue;

      const shortfall = round2(c.targetValue - c.deliveredValue);
      const proxyGap = c.proxyValuePerUnit != null ? round2(shortfall * c.proxyValuePerUnit) : null;
      const key = c.id;
      keys.add(key);
      const raise = await raiseSignalOnce(tx, {
        companyId,
        projectId,
        detector: "social_value_shortfall",
        key,
        severity: "medium",
        confidence: 1,
        title: `Social value shortfall — SV-${String(c.number).padStart(4, "0")}: ${c.description.slice(0, 80)}`,
        explanation:
          `Commitment SV-${String(c.number).padStart(4, "0")} ("${c.description}") promised ` +
          `${c.targetValue} ${c.unit} by ${c.dueDate}. ${c.deliveredValue} ${c.unit} have been ` +
          `evidenced — a shortfall of ${shortfall} ${c.unit} ` +
          `(${percent(c.deliveredValue, c.targetValue)}% delivered), now more than 30 days past ` +
          `the due date.` +
          (proxyGap != null ? ` Proxy financial value not delivered: ${proxyGap}.` : "") +
          ` Tender commitments are scored obligations: an unremediated shortfall is a ` +
          `contract-performance issue and, on UK public work, a disclosable one.`,
        subjectType: "social_value_commitment",
        subjectId: c.id,
        evidenceRefs: {
          commitmentId: c.id,
          number: c.number,
          shortfall,
          dueDate: c.dueDate,
          proxyValueShortfall: proxyGap,
        },
        ledger: { objectType: "social_value_commitment", objectId: c.id },
      });
      if (raise.raised) result.raised += 1;
      else result.repeat += 1;
    }

    result.closed += await reconcileSignals(
      tx,
      companyId,
      projectId,
      "social_value_shortfall",
      keys,
      "The commitment was delivered, or its target and due date were revised.",
    );
    return result;
  });
}

/* ------------------------------------------------------------------ */
/* Environmental limits and incidents                                  */
/* ------------------------------------------------------------------ */

export async function sweepEnvironment(
  db: Db,
  companyId: string,
  projectId: string,
  now = new Date(),
): Promise<SweepResult> {
  return withDetectorLock(db, companyId, projectId, "environment", async (tx) => {
    const result = emptySweep();

    /* (a) limit exceedances — one finding per exceeding reading, so a point
       that breached in March and again in July has two, not one that never
       closes. */
    const exceedances = await tx
      .select({
        readingId: monitoringReadings.id,
        readingAt: monitoringReadings.readingAt,
        value: monitoringReadings.value,
        exceedanceBy: monitoringReadings.exceedanceBy,
        pointId: monitoringPoints.id,
        pointName: monitoringPoints.name,
        medium: monitoringPoints.medium,
        parameter: monitoringPoints.parameter,
        unit: monitoringPoints.unit,
        limitValue: monitoringPoints.limitValue,
        limitDirection: monitoringPoints.limitDirection,
        limitBasis: monitoringPoints.limitBasis,
      })
      .from(monitoringReadings)
      .innerJoin(monitoringPoints, eq(monitoringReadings.pointId, monitoringPoints.id))
      .where(
        and(
          eq(monitoringReadings.companyId, companyId),
          eq(monitoringReadings.projectId, projectId),
          eq(monitoringReadings.exceedance, 1),
        ),
      )
      .orderBy(asc(monitoringReadings.readingAt));

    const exceedanceKeys = new Set<string>();
    for (const r of exceedances) {
      exceedanceKeys.add(r.readingId);
      const raise = await raiseSignalOnce(tx, {
        companyId,
        projectId,
        detector: "environmental_limit_exceeded",
        key: r.readingId,
        severity: "high",
        confidence: 1,
        title: `Consent limit exceeded — ${r.pointName}: ${r.parameter} ${r.value} ${r.unit}`,
        explanation:
          `The ${r.readingAt} reading at monitoring point "${r.pointName}" recorded ` +
          `${r.parameter} of ${r.value} ${r.unit} against a ${r.limitDirection === "min" ? "floor" : "ceiling"} ` +
          `of ${r.limitValue} ${r.unit}` +
          (r.exceedanceBy != null ? `, out by ${r.exceedanceBy} ${r.unit}` : "") +
          `. ${r.limitBasis ? `The limit derives from: ${r.limitBasis}.` : "No basis is recorded for the limit, which weakens the record either way."} ` +
          `An exceedance of a consent limit is a breach of the consent whether or not anyone ` +
          `complained, and the regulator's first question is when it was noticed.`,
        subjectType: "environmental_monitoring_point",
        subjectId: r.pointId,
        evidenceRefs: {
          readingId: r.readingId,
          pointId: r.pointId,
          medium: r.medium,
          parameter: r.parameter,
          value: r.value,
          limitValue: r.limitValue,
          limitDirection: r.limitDirection,
          readingAt: r.readingAt,
        },
        ledger: {
          objectType: "environmental_reading",
          objectId: r.readingId,
          payload: { pointId: r.pointId, value: r.value, limitValue: r.limitValue },
        },
      });
      if (raise.raised) result.raised += 1;
      else result.repeat += 1;
    }
    result.closed += await reconcileSignals(
      tx,
      companyId,
      projectId,
      "environmental_limit_exceeded",
      exceedanceKeys,
      "The reading was corrected, deleted, or the point's limit was revised so it no longer breaches.",
    );

    /* (b) reportable incidents past the notification window */
    const incidents = await tx
      .select()
      .from(environmentalIncidents)
      .where(
        and(
          eq(environmentalIncidents.companyId, companyId),
          eq(environmentalIncidents.projectId, projectId),
          eq(environmentalIncidents.reportableToRegulator, 1),
          isNull(environmentalIncidents.regulatorNotifiedAt),
        ),
      );
    const incidentKeys = new Set<string>();
    for (const inc of incidents) {
      const occurred = Date.parse(`${inc.occurredAt}T00:00:00Z`);
      const hours = (now.getTime() - occurred) / 3_600_000;
      if (hours < REGULATOR_NOTIFICATION_HOURS) continue;
      incidentKeys.add(inc.id);
      const raise = await raiseSignalOnce(tx, {
        companyId,
        projectId,
        detector: "environmental_incident_unreported",
        key: inc.id,
        severity: inc.severity === "critical" ? "critical" : "high",
        confidence: 1,
        title: `Reportable environmental incident not notified — EI-${inc.number} (${inc.kind})`,
        explanation:
          `Incident EI-${inc.number} (${inc.kind}, severity ${inc.severity}) occurred on ` +
          `${inc.occurredAt} and is flagged as reportable to the regulator, but no notification ` +
          `has been recorded ${Math.floor(hours)} hours later. Statutory notification windows ` +
          `for a reportable pollution incident are commonly ${REGULATOR_NOTIFICATION_HOURS} ` +
          `hours; late self-reporting converts an incident into an enforcement matter, and ` +
          `non-reporting is itself the offence in most regimes.`,
        subjectType: "environmental_incident",
        subjectId: inc.id,
        evidenceRefs: {
          incidentId: inc.id,
          number: inc.number,
          kind: inc.kind,
          occurredAt: inc.occurredAt,
          hoursElapsed: Math.floor(hours),
          regulator: inc.regulator,
        },
        ledger: { objectType: "environmental_incident", objectId: inc.id },
      });
      if (raise.raised) result.raised += 1;
      else result.repeat += 1;
    }
    result.closed += await reconcileSignals(
      tx,
      companyId,
      projectId,
      "environmental_incident_unreported",
      incidentKeys,
      "The regulator was notified, or the incident is no longer flagged reportable.",
    );

    /* (c) biodiversity net loss */
    const habitat = await tx
      .select()
      .from(biodiversityUnitsTable)
      .where(
        and(
          eq(biodiversityUnitsTable.companyId, companyId),
          eq(biodiversityUnitsTable.projectId, projectId),
        ),
      );
    const netLossKeys = new Set<string>();
    if (habitat.length > 0) {
      const sum = (stage: string) =>
        habitat.filter((h) => h.stage === stage).reduce((s, h) => s + h.units, 0);
      const baseline = sum("baseline");
      const post = sum("post_intervention");
      const target = habitat.some((h) => h.stage === "target") ? sum("target") : null;
      const gain = computeNetGain({
        baselineUnits: baseline,
        postInterventionUnits: post,
        targetUnits: target,
      });
      if (baseline > 0 && post > 0 && gain.netLoss) {
        const key = `${projectId}:${round2(baseline)}:${round2(post)}`;
        netLossKeys.add(key);
        const raise = await raiseSignalOnce(tx, {
          companyId,
          projectId,
          detector: "biodiversity_net_loss",
          key,
          severity: "high",
          confidence: 0.9,
          title: `Biodiversity net LOSS — ${gain.netChangeUnits} habitat units`,
          explanation:
            `The habitat accounts for this project show ${gain.postInterventionUnits} units ` +
            `post-intervention against a ${gain.baselineUnits}-unit baseline: a net LOSS of ` +
            `${Math.abs(gain.netChangeUnits)} units (${gain.netGainPercent}%). ${gain.basis} ` +
            `A net loss is not a rounding difference — where net gain is a planning condition ` +
            `it is a breach of that condition, and where it is a contractual ESG commitment it ` +
            `is a shortfall against the tender.`,
          subjectType: "project",
          subjectId: projectId,
          evidenceRefs: {
            baselineUnits: gain.baselineUnits,
            postInterventionUnits: gain.postInterventionUnits,
            targetUnits: gain.targetUnits,
            netChangeUnits: gain.netChangeUnits,
            netGainPercent: gain.netGainPercent,
          },
          ledger: { objectType: "project", objectId: projectId },
        });
        if (raise.raised) result.raised += 1;
        else result.repeat += 1;
      }
    }
    result.closed += await reconcileSignals(
      tx,
      companyId,
      projectId,
      "biodiversity_net_loss",
      netLossKeys,
      "The habitat accounts no longer show a net loss.",
    );

    return result;
  });
}

/* ------------------------------------------------------------------ */
/* Orchestration                                                       */
/* ------------------------------------------------------------------ */

async function esgProjectIds(db: Db, companyId: string): Promise<string[]> {
  const ids = new Set<string>();
  const add = (rows: { projectId: string }[]) => rows.forEach((r) => ids.add(r.projectId));
  add(
    await db
      .selectDistinct({ projectId: carbonBudgets.projectId })
      .from(carbonBudgets)
      .where(eq(carbonBudgets.companyId, companyId)),
  );
  add(
    await db
      .selectDistinct({ projectId: socialValueCommitments.projectId })
      .from(socialValueCommitments)
      .where(eq(socialValueCommitments.companyId, companyId)),
  );
  add(
    await db
      .selectDistinct({ projectId: monitoringReadings.projectId })
      .from(monitoringReadings)
      .where(eq(monitoringReadings.companyId, companyId)),
  );
  add(
    await db
      .selectDistinct({ projectId: environmentalIncidents.projectId })
      .from(environmentalIncidents)
      .where(eq(environmentalIncidents.companyId, companyId)),
  );
  add(
    await db
      .selectDistinct({ projectId: biodiversityUnitsTable.projectId })
      .from(biodiversityUnitsTable)
      .where(eq(biodiversityUnitsTable.companyId, companyId)),
  );
  return [...ids];
}

export async function runEsgDetectors(
  db: Db,
  companyId: string,
  projectId: string,
  today = todayISO(),
): Promise<SweepResult> {
  return mergeSweeps(
    await sweepCarbonBudgets(db, companyId, projectId),
    await sweepSocialValue(db, companyId, projectId, today),
    await sweepEnvironment(db, companyId, projectId),
  );
}

export async function runEsgDetectorsForCompany(
  db: Db,
  companyId: string,
  today = todayISO(),
): Promise<{ projects: number; result: SweepResult }> {
  const ids = await esgProjectIds(db, companyId);
  let result = emptySweep();
  for (const projectId of ids) {
    result = mergeSweeps(result, await runEsgDetectors(db, companyId, projectId, today));
  }
  return { projects: ids.length, result };
}

export function registerEsgJobs(app: FastifyInstance): void {
  app.scheduler.register({
    name: "esg.detectors",
    description:
      "Carbon budget exceedance (re-armed by a target revision), social value status and " +
      "shortfall, environmental consent-limit exceedances, unnotified reportable incidents " +
      "and biodiversity net loss — over every project holding ESG records",
    everyMs: 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) =>
      forEachCompany(db, (companyId) =>
        runEsgDetectorsForCompany(db, companyId, now.toISOString().slice(0, 10)),
      ),
  });
}
