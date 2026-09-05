/**
 * Scheduled work for capital governance.
 *
 *  1. `governance.benefits` — recompute every benefit's realisation status
 *     from its latest reading (#418). Before this, a benefit at 30% progress
 *     with a target date a hundred days in the past stayed "tracking"
 *     forever unless somebody happened to write to it, and its owner was
 *     never told. Status is now recomputed on a schedule AND lazily on read.
 *  2. `governance.assurance-actions` — move assurance actions past their due
 *     date to `overdue`, breach their obligation and notify the owner (#415).
 *  3. `governance.gate-conditions` — breach the obligation behind a gate
 *     condition of approval whose due date has passed (#413), so a condition
 *     nobody closed shows up on the assurance register rather than quietly
 *     ageing inside a review's JSON.
 */
import type { FastifyInstance } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import {
  assuranceActions,
  benefitReadings,
  benefits,
  gateReviews,
  obligations,
  stageGates,
} from "@constructos/db";
import type { BenefitStatus } from "@constructos/shared";
import { forEachCompany } from "../../lib/scheduler.js";
import type { Db } from "../../lib/db.js";
import { appendLedger } from "../../lib/ledger.js";
import { pushNotifications } from "../notifications/service.js";
import { benefitProgressPercent, benefitStatusFor } from "./appraisal.js";
import { raiseSignalOnce } from "./signals.js";

/** The stored shape of a condition of approval on a gate review. */
export interface GateConditionRow {
  id: string;
  text: string;
  dueDate: string | null;
  obligationId: string;
  closed: boolean;
  closedAt: string | null;
  closedBy: string | null;
  closeNote: string | null;
}

/* ------------------------------------------------------------------ */
/* Benefits (#418)                                                     */
/* ------------------------------------------------------------------ */

export interface BenefitSweepResult {
  checked: number;
  changed: Array<{ id: string; from: string; to: BenefitStatus }>;
}

/**
 * Recompute realisation status for a set of benefits from their latest
 * readings. Shared by the scheduler and by the lazy read-path sweep so the
 * two can never disagree about what "missed" means.
 *
 * `actorId` is null when the scheduler runs it — the platform is the actor,
 * not whoever happened to open the page.
 */
export async function sweepBenefitStatuses(
  db: Db,
  companyId: string,
  options: { projectId?: string; benefitIds?: string[]; actorId: string | null; today: string },
): Promise<BenefitSweepResult> {
  const clauses = [eq(benefits.companyId, companyId)];
  if (options.projectId) clauses.push(eq(benefits.projectId, options.projectId));
  if (options.benefitIds && options.benefitIds.length > 0) {
    clauses.push(inArray(benefits.id, options.benefitIds));
  }
  const rows = await db
    .select()
    .from(benefits)
    .where(and(...clauses));
  if (rows.length === 0) return { checked: 0, changed: [] };

  const readings = await db
    .select()
    .from(benefitReadings)
    .where(
      inArray(
        benefitReadings.benefitId,
        rows.map((b) => b.id),
      ),
    );
  // latest reading per benefit, by date then insertion order
  const latest = new Map<string, { readingDate: string; createdAt: string; value: number }>();
  for (const r of readings) {
    const current = latest.get(r.benefitId);
    if (
      !current ||
      r.readingDate > current.readingDate ||
      (r.readingDate === current.readingDate && r.createdAt > current.createdAt)
    ) {
      latest.set(r.benefitId, {
        readingDate: r.readingDate,
        createdAt: r.createdAt,
        value: r.value,
      });
    }
  }

  const changed: BenefitSweepResult["changed"] = [];
  for (const b of rows) {
    const reading = latest.get(b.id);
    const progress =
      reading === undefined
        ? null
        : benefitProgressPercent(b.baselineValue, b.targetValue, reading.value);
    const next = benefitStatusFor(progress, b.targetDate, options.today);
    if (next === b.status) continue;
    await db
      .update(benefits)
      .set({ status: next, updatedAt: new Date().toISOString() })
      .where(and(eq(benefits.id, b.id), eq(benefits.status, b.status)));
    await appendLedger(db, {
      companyId,
      actorId: options.actorId,
      action: "state_change",
      objectType: "benefit",
      objectId: b.id,
      payload: { from: b.status, to: next, progressPercent: progress, sweep: true },
      projectId: b.projectId,
    });
    if ((next === "at_risk" || next === "missed") && b.ownerId) {
      await pushNotifications(db, [
        {
          companyId,
          userId: b.ownerId,
          projectId: b.projectId,
          kind: "status_change",
          title: `Benefit "${b.name}" is now ${next === "at_risk" ? "at risk" : "missed"}`,
          body:
            `Benefit #${b.number} (${b.name}) moved from ${b.status} to ${next}: progress ` +
            `${progress === null ? "not measured" : `${progress}%`} against a target of ` +
            `${b.targetValue} ${b.unit}` +
            (b.targetDate ? ` by ${b.targetDate}.` : "."),
          recordType: "benefit",
          recordId: b.id,
        },
      ]);
    }
    changed.push({ id: b.id, from: b.status, to: next });
  }
  return { checked: rows.length, changed };
}

/* ------------------------------------------------------------------ */
/* Assurance actions (#415)                                            */
/* ------------------------------------------------------------------ */

export async function sweepAssuranceActions(
  db: Db,
  companyId: string,
  today: string,
): Promise<{ checked: number; overdue: number }> {
  const rows = await db
    .select()
    .from(assuranceActions)
    .where(
      and(
        eq(assuranceActions.companyId, companyId),
        inArray(assuranceActions.status, ["open", "in_progress"]),
      ),
    );
  let overdue = 0;
  for (const a of rows) {
    if (!a.dueDate || a.dueDate >= today) continue;
    await db
      .update(assuranceActions)
      .set({ status: "overdue", updatedAt: new Date().toISOString() })
      .where(
        and(eq(assuranceActions.id, a.id), inArray(assuranceActions.status, ["open", "in_progress"])),
      );
    if (a.obligationId) {
      await db
        .update(obligations)
        .set({ status: "breached" })
        .where(and(eq(obligations.id, a.obligationId), eq(obligations.status, "open")));
    }
    await raiseSignalOnce(db, {
      companyId,
      projectId: a.projectId,
      detector: "assurance_action_overdue",
      key: a.id,
      severity: a.priority === "critical" ? "high" : "medium",
      confidence: 1,
      title: `Assurance action overdue — ${a.title}`,
      explanation:
        `Assurance action #${a.number} ("${a.title}", ${a.priority}) fell due on ${a.dueDate} ` +
        `and has not been closed. An assurance recommendation that nobody actions is the ` +
        `mechanism by which a review becomes theatre; the obligation behind it is now breached.`,
      subjectType: "assurance_action",
      subjectId: a.id,
      evidenceRefs: { actionId: a.id, dueDate: a.dueDate, ownerId: a.ownerId },
    });
    if (a.ownerId) {
      await pushNotifications(db, [
        {
          companyId,
          userId: a.ownerId,
          projectId: a.projectId,
          kind: "overdue",
          title: `Assurance action #${a.number} is overdue`,
          body: `"${a.title}" was due on ${a.dueDate}.`,
          recordType: "assurance_action",
          recordId: a.id,
        },
      ]);
    }
    await appendLedger(db, {
      companyId,
      actorId: null,
      action: "state_change",
      objectType: "assurance_action",
      objectId: a.id,
      payload: { from: a.status, to: "overdue", dueDate: a.dueDate },
      projectId: a.projectId,
    });
    overdue += 1;
  }
  return { checked: rows.length, overdue };
}

/* ------------------------------------------------------------------ */
/* Gate conditions (#413)                                              */
/* ------------------------------------------------------------------ */

export async function sweepGateConditions(
  db: Db,
  companyId: string,
  today: string,
): Promise<{ reviews: number; breached: number }> {
  const reviews = await db
    .select()
    .from(gateReviews)
    .where(eq(gateReviews.companyId, companyId));
  if (reviews.length === 0) return { reviews: 0, breached: 0 };
  const gates = await db.select().from(stageGates).where(eq(stageGates.companyId, companyId));
  const gateById = new Map(gates.map((g) => [g.id, g]));
  let breached = 0;
  for (const review of reviews) {
    const conditions = review.conditions as GateConditionRow[];
    for (const c of conditions) {
      if (c.closed || !c.dueDate || c.dueDate >= today) continue;
      const updated = await db
        .update(obligations)
        .set({ status: "breached" })
        .where(and(eq(obligations.id, c.obligationId), eq(obligations.status, "open")))
        .returning({ id: obligations.id });
      if (updated.length === 0) continue;
      const gate = gateById.get(review.gateId);
      await raiseSignalOnce(db, {
        companyId,
        projectId: review.projectId,
        detector: "gate_condition_overdue",
        key: c.id,
        severity: "high",
        confidence: 1,
        title: `Gate condition of approval overdue — Gate ${gate?.gateNumber ?? "?"}`,
        explanation:
          `The condition "${c.text}" attached to the ${review.decision} decision at Gate ` +
          `${gate?.gateNumber ?? "?"} (${gate?.name ?? "unknown gate"}) fell due on ${c.dueDate} ` +
          `and is still open. A gate passed "with conditions" whose conditions are never closed ` +
          `is a gate that was not passed.`,
        subjectType: "gate_condition",
        subjectId: c.id,
        evidenceRefs: { reviewId: review.id, gateId: review.gateId, obligationId: c.obligationId },
      });
      await appendLedger(db, {
        companyId,
        actorId: null,
        action: "state_change",
        objectType: "gate_condition",
        objectId: c.id,
        payload: { reviewId: review.id, obligationId: c.obligationId, status: "breached" },
        projectId: review.projectId,
      });
      breached += 1;
    }
  }
  return { reviews: reviews.length, breached };
}

/* ------------------------------------------------------------------ */
/* Registration                                                        */
/* ------------------------------------------------------------------ */

export function registerGovernanceJobs(app: FastifyInstance): void {
  app.scheduler.register({
    name: "governance.benefits",
    description:
      "Recompute benefit realisation status from the latest readings and notify owners when a benefit falls to at risk or missed",
    everyMs: 12 * 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) =>
      forEachCompany(db, (companyId) =>
        sweepBenefitStatuses(db, companyId, {
          actorId: null,
          today: now.toISOString().slice(0, 10),
        }),
      ),
  });

  app.scheduler.register({
    name: "governance.assurance-actions",
    description:
      "Move assurance actions past their due date to overdue, breach the backing obligation and tell the owner",
    everyMs: 6 * 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) =>
      forEachCompany(db, (companyId) =>
        sweepAssuranceActions(db, companyId, now.toISOString().slice(0, 10)),
      ),
  });

  app.scheduler.register({
    name: "governance.gate-conditions",
    description:
      "Breach the obligation behind any condition of approval that has passed its due date unclosed",
    everyMs: 12 * 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) =>
      forEachCompany(db, (companyId) =>
        sweepGateConditions(db, companyId, now.toISOString().slice(0, 10)),
      ),
  });
}
