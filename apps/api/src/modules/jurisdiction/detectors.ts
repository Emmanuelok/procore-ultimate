/**
 * Jurisdiction scheduled detectors — permits, ICV certificates and local
 * content.
 *
 * These replace three lazy sweeps that ran inside `GET /permits` and
 * `GET /permits/schedule-risk` with no lock and no unique key. The permit tab
 * loads both in parallel, so both requests used to read "no signal yet" and
 * both inserted one; the expiry flip was guarded by a conditional UPDATE but
 * the signal insert and the ledger append ran regardless of whether that
 * UPDATE matched a row.
 *
 * TRIGGER CONTRACT. `sweepPermits` has two triggers that run the same
 * function: the scheduled `jurisdiction.detectors` job (hourly, every tenant,
 * so a project nobody opens is still policed) and `GET /permits`, scoped to
 * the project being read. The scheduler is disabled under NODE_ENV=test and
 * by SCHEDULER_ENABLED=false, so there the read is the only trigger (every
 * test, the retrodetect harness); the advisory lock, the guarded flip and the
 * fingerprint are what make a second trigger — or two parallel reads — a
 * no-op, not the absence of a read-side call.
 *
 * Families here:
 *
 *   · DETERMINATION OVERDUE (#585-590) — the authority has blown its own
 *     statutory period. That is an employer-risk event before it is a
 *     chase-up email, and the entitlement argument later rests on the date
 *     it was first recorded.
 *   · PERMIT EXPIRED — a granted consent whose expiry has passed. The status
 *     flip and the finding are one guarded operation.
 *   · ICV CERTIFICATE EXPIRY (#612-615) — in Gulf ICV and Nigerian NCDMB
 *     regimes an expired certificate is an exclusion from tendering, so it
 *     is warned about ahead of time and its expiry is an Obligation.
 *   · LOCAL CONTENT SHORTFALL — the latest reading against a contractual
 *     floor, keyed on the reading so a corrected reading is a new finding
 *     and a superseded one closes.
 *
 * The consent-to-programme detector for permits lives in the land module's
 * consent service, because a task blocked by both a parcel and a permit is
 * one problem and must be reported once.
 */

import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import {
  icvCertificates,
  localContentReadings,
  localContentTargets,
  obligations,
  permits,
} from "@constructos/db";
import { appendLedger } from "../../lib/ledger.js";
import { forEachCompany } from "../../lib/scheduler.js";
import type { Db } from "../../lib/db.js";
import { addDaysISO, todayISO } from "../field/dates.js";
import {
  emptySweep,
  mergeSweeps,
  raiseSignalOnce,
  reconcileSignals,
  withDetectorLock,
  type SweepResult,
} from "../land/signals.js";
import { ICV_EXPIRY_WARN_DAYS, PERMIT_AWAITING_STATUSES } from "./reference.js";
import { round2 } from "./fx.js";

/* ------------------------------------------------------------------ */
/* Permits                                                             */
/* ------------------------------------------------------------------ */

export async function sweepPermits(
  db: Db,
  companyId: string,
  projectId: string,
  today = todayISO(),
): Promise<SweepResult> {
  return withDetectorLock(db, companyId, projectId, "permits", async (tx) => {
    const result = emptySweep();

    /* (a) determination overdue */
    const awaiting = await tx
      .select()
      .from(permits)
      .where(
        and(
          eq(permits.companyId, companyId),
          eq(permits.projectId, projectId),
          inArray(permits.status, [...PERMIT_AWAITING_STATUSES]),
          isNotNull(permits.dueAt),
          lt(permits.dueAt, today),
        ),
      );
    const overdueKeys = new Set<string>();
    for (const permit of awaiting) {
      overdueKeys.add(permit.id);
      if (permit.obligationId) {
        await tx
          .update(obligations)
          .set({ status: "breached" })
          .where(and(eq(obligations.id, permit.obligationId), eq(obligations.status, "open")));
      }
      const raise = await raiseSignalOnce(tx, {
        companyId,
        projectId,
        detector: "permit_determination_overdue",
        key: permit.id,
        severity: "medium",
        confidence: 1,
        title: `Permit determination overdue — ${permit.authority}: ${permit.title}`,
        explanation:
          `Permit PRM-${permit.number} (${permit.kind}) was submitted to ${permit.authority} on ` +
          `${permit.appliedAt} with an expected determination period of ${permit.expectedDays} ` +
          `days, expiring ${permit.dueAt}. No determination has been recorded. Authority delay ` +
          `beyond the statutory period is normally an employer-risk event: record the chase ` +
          `correspondence now, because the entitlement argument later rests on it.`,
        subjectType: "permit",
        subjectId: permit.id,
        evidenceRefs: {
          permitId: permit.id,
          number: permit.number,
          dueAt: permit.dueAt,
          appliedAt: permit.appliedAt,
          authority: permit.authority,
        },
        ledger: {
          objectType: "permit",
          objectId: permit.id,
          payload: { determination: "overdue", dueAt: permit.dueAt },
        },
      });
      if (raise.raised) result.raised += 1;
      else result.repeat += 1;
    }
    result.closed += await reconcileSignals(
      tx,
      companyId,
      projectId,
      "permit_determination_overdue",
      overdueKeys,
      "The authority determined the application, or the determination date moved.",
    );

    /* (b) granted but expired — flip and finding are one guarded operation */
    const lapsed = await tx
      .select()
      .from(permits)
      .where(
        and(
          eq(permits.companyId, companyId),
          eq(permits.projectId, projectId),
          eq(permits.status, "granted"),
          isNotNull(permits.expiresAt),
          lt(permits.expiresAt, today),
        ),
      );
    for (const permit of lapsed) {
      const flipped = await tx
        .update(permits)
        .set({ status: "expired", updatedAt: new Date().toISOString() })
        .where(and(eq(permits.id, permit.id), eq(permits.status, "granted")))
        .returning({ id: permits.id });
      if (flipped.length === 0) continue; // another runner got there first
      await appendLedger(tx, {
        companyId,
        actorId: null,
        action: "state_change",
        objectType: "permit",
        objectId: permit.id,
        projectId,
        payload: { from: "granted", to: "expired", expiresAt: permit.expiresAt },
        storePayload: true,
      });
      const raise = await raiseSignalOnce(tx, {
        companyId,
        projectId,
        detector: "permit_expired",
        key: `${permit.id}:${permit.expiresAt}`,
        severity: "high",
        confidence: 1,
        title: `Permit expired — ${permit.authority}: ${permit.title}`,
        explanation:
          `Permit PRM-${permit.number} (${permit.kind}), granted ${permit.grantedAt} by ` +
          `${permit.authority}, expired on ${permit.expiresAt}. Any activity still relying on ` +
          `this consent is proceeding without authority and is exposed to a stop notice, ` +
          `prosecution or insurance avoidance. Renew or suspend the dependent work.`,
        subjectType: "permit",
        subjectId: permit.id,
        evidenceRefs: {
          permitId: permit.id,
          number: permit.number,
          expiresAt: permit.expiresAt,
          grantedAt: permit.grantedAt,
        },
        ledger: { objectType: "permit", objectId: permit.id },
      });
      if (raise.raised) result.raised += 1;
      else result.repeat += 1;
    }

    return result;
  });
}

/* ------------------------------------------------------------------ */
/* ICV certificates                                                    */
/* ------------------------------------------------------------------ */

export async function sweepIcvCertificates(
  db: Db,
  companyId: string,
  projectId: string,
  today = todayISO(),
): Promise<SweepResult> {
  return withDetectorLock(db, companyId, projectId, "icv", async (tx) => {
    const result = emptySweep();
    const rows = await tx
      .select()
      .from(icvCertificates)
      .where(
        and(
          eq(icvCertificates.companyId, companyId),
          eq(icvCertificates.projectId, projectId),
          inArray(icvCertificates.status, ["issued", "expiring"]),
          isNotNull(icvCertificates.expiresAt),
        ),
      );
    const warnHorizon = addDaysISO(today, ICV_EXPIRY_WARN_DAYS);
    const keys = new Set<string>();
    for (const cert of rows) {
      if (!cert.expiresAt) continue;
      const expired = cert.expiresAt < today;
      const expiring = !expired && cert.expiresAt <= warnHorizon;
      if (!expired && !expiring) {
        // Back inside its validity window (a renewal moved the date out):
        // reset the status the sweep previously advanced.
        if (cert.status === "expiring") {
          await tx
            .update(icvCertificates)
            .set({ status: "issued", updatedAt: new Date().toISOString() })
            .where(and(eq(icvCertificates.id, cert.id), eq(icvCertificates.status, "expiring")));
        }
        continue;
      }
      const nextStatus = expired ? "expired" : "expiring";
      if (cert.status !== nextStatus) {
        const flipped = await tx
          .update(icvCertificates)
          .set({ status: nextStatus, updatedAt: new Date().toISOString() })
          .where(and(eq(icvCertificates.id, cert.id), eq(icvCertificates.status, cert.status)))
          .returning({ id: icvCertificates.id });
        if (flipped.length > 0) {
          await appendLedger(tx, {
            companyId,
            actorId: null,
            action: "state_change",
            objectType: "icv_certificate",
            objectId: cert.id,
            projectId,
            payload: { from: cert.status, to: nextStatus, expiresAt: cert.expiresAt },
            storePayload: true,
          });
          if (expired && cert.obligationId) {
            await tx
              .update(obligations)
              .set({ status: "breached" })
              .where(and(eq(obligations.id, cert.obligationId), eq(obligations.status, "open")));
          }
        }
      }
      const key = `${cert.id}:${cert.expiresAt}`;
      keys.add(key);
      const days = Math.round(
        (Date.parse(`${cert.expiresAt}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) /
          86_400_000,
      );
      const raise = await raiseSignalOnce(tx, {
        companyId,
        projectId,
        detector: "icv_certificate_expiring",
        key,
        severity: expired ? "high" : "medium",
        confidence: 1,
        title: expired
          ? `ICV certificate expired — ${cert.entityName} (${cert.issuer})`
          : `ICV certificate expires in ${days} day(s) — ${cert.entityName}`,
        explanation:
          `Certificate ${cert.certificateNumber} issued by ${cert.issuer} for ${cert.entityName} ` +
          `in ${cert.jurisdiction}` +
          (cert.score != null ? ` (score ${cert.score}${cert.scoreUnit})` : "") +
          ` ${expired ? `expired on ${cert.expiresAt}` : `expires on ${cert.expiresAt}`}. ` +
          `In Gulf In-Country Value and Nigerian NCDMB regimes the certificate is the tender ` +
          `currency: an expired one is an exclusion from bidding and, on a live contract, a ` +
          `ground for withholding certificates. Recertification takes weeks, so the warning is ` +
          `raised ${ICV_EXPIRY_WARN_DAYS} days out rather than on the day.`,
        subjectType: "icv_certificate",
        subjectId: cert.id,
        evidenceRefs: {
          certificateId: cert.id,
          certificateNumber: cert.certificateNumber,
          issuer: cert.issuer,
          expiresAt: cert.expiresAt,
          daysToExpiry: days,
          expired,
        },
        ledger: { objectType: "icv_certificate", objectId: cert.id },
      });
      if (raise.raised) result.raised += 1;
      else result.repeat += 1;
    }
    result.closed += await reconcileSignals(
      tx,
      companyId,
      projectId,
      "icv_certificate_expiring",
      keys,
      "The certificate was renewed, superseded or withdrawn.",
    );
    return result;
  });
}

/* ------------------------------------------------------------------ */
/* Local content                                                       */
/* ------------------------------------------------------------------ */

export async function sweepLocalContent(
  db: Db,
  companyId: string,
  projectId: string,
): Promise<SweepResult> {
  return withDetectorLock(db, companyId, projectId, "local-content", async (tx) => {
    const result = emptySweep();
    const targets = await tx
      .select()
      .from(localContentTargets)
      .where(
        and(
          eq(localContentTargets.companyId, companyId),
          eq(localContentTargets.projectId, projectId),
        ),
      );
    const keys = new Set<string>();
    for (const target of targets) {
      const latest = await tx
        .select()
        .from(localContentReadings)
        .where(
          and(
            eq(localContentReadings.targetId, target.id),
            eq(localContentReadings.companyId, companyId),
            isNull(localContentReadings.supersededById),
          ),
        )
        .orderBy(desc(localContentReadings.readingDate), desc(localContentReadings.createdAt))
        .limit(1);
      const reading = latest[0];
      if (!reading || reading.compliant === 1) continue;
      const key = reading.id;
      keys.add(key);
      const gap = round2(target.targetValue - reading.value);
      const raise = await raiseSignalOnce(tx, {
        companyId,
        projectId,
        detector: "local_content_shortfall",
        key,
        severity: "medium",
        confidence: 1,
        title:
          `Local content shortfall — ${target.name}: ${reading.value}${target.unit} against a ` +
          `${target.targetValue}${target.unit} floor`,
        explanation:
          `The ${reading.readingDate} reading of "${target.name}" (${target.metric}, ` +
          `${target.jurisdiction}) is ${reading.value}${target.unit}, ${gap}${target.unit} below ` +
          `the contractual floor of ${target.targetValue}${target.unit}. Local content and ` +
          `in-country value undertakings are typically conditions of the licence or ` +
          `concession: sustained shortfall attracts penalties, withheld certificates or, in ` +
          `Gulf ICV regimes, exclusion from future tenders. ` +
          (reading.basis
            ? `Basis: ${reading.basis}`
            : "No basis of measurement was stated for this reading.") +
          ` (source: ${reading.source})`,
        subjectType: "local_content_target",
        subjectId: target.id,
        evidenceRefs: {
          targetId: target.id,
          readingId: reading.id,
          value: reading.value,
          targetValue: target.targetValue,
          gap,
          source: reading.source,
        },
        ledger: { objectType: "local_content_target", objectId: target.id },
      });
      if (raise.raised) result.raised += 1;
      else result.repeat += 1;
    }
    result.closed += await reconcileSignals(
      tx,
      companyId,
      projectId,
      "local_content_shortfall",
      keys,
      "A later reading meets the floor, or the breaching reading was superseded.",
    );
    return result;
  });
}

/* ------------------------------------------------------------------ */
/* Orchestration                                                       */
/* ------------------------------------------------------------------ */

async function jurisdictionProjectIds(db: Db, companyId: string): Promise<string[]> {
  const ids = new Set<string>();
  const add = (rows: { projectId: string }[]) => rows.forEach((r) => ids.add(r.projectId));
  add(
    await db
      .selectDistinct({ projectId: permits.projectId })
      .from(permits)
      .where(eq(permits.companyId, companyId)),
  );
  add(
    await db
      .selectDistinct({ projectId: localContentTargets.projectId })
      .from(localContentTargets)
      .where(eq(localContentTargets.companyId, companyId)),
  );
  add(
    await db
      .selectDistinct({ projectId: icvCertificates.projectId })
      .from(icvCertificates)
      .where(eq(icvCertificates.companyId, companyId)),
  );
  return [...ids];
}

export async function runJurisdictionDetectors(
  db: Db,
  companyId: string,
  projectId: string,
  today = todayISO(),
): Promise<SweepResult> {
  return mergeSweeps(
    await sweepPermits(db, companyId, projectId, today),
    await sweepIcvCertificates(db, companyId, projectId, today),
    await sweepLocalContent(db, companyId, projectId),
  );
}

export async function runJurisdictionDetectorsForCompany(
  db: Db,
  companyId: string,
  today = todayISO(),
): Promise<{ projects: number; result: SweepResult }> {
  const ids = await jurisdictionProjectIds(db, companyId);
  let result = emptySweep();
  for (const projectId of ids) {
    result = mergeSweeps(result, await runJurisdictionDetectors(db, companyId, projectId, today));
  }
  return { projects: ids.length, result };
}

export function registerJurisdictionJobs(app: FastifyInstance): void {
  app.scheduler.register({
    name: "jurisdiction.detectors",
    description:
      "Permit determinations past their statutory period, granted permits that have lapsed, " +
      "ICV certificates expiring or expired, and local-content readings below their " +
      "contractual floor — over every project holding jurisdiction records",
    everyMs: 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) =>
      forEachCompany(db, (companyId) =>
        runJurisdictionDetectorsForCompany(db, companyId, now.toISOString().slice(0, 10)),
      ),
  });
}

/** Ordering helper shared with the routes. */
export const readingOrder = [asc(localContentReadings.readingDate)];
