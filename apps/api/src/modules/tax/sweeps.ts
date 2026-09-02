import type { FastifyInstance } from "fastify";
import { and, desc, eq, gte, inArray, isNotNull, lt, ne } from "drizzle-orm";
import {
  commitmentPayments,
  commitments,
  peExposures,
  taxDeterminations,
  taxPeriods,
  taxProjectProfiles,
  taxRegistrations,
  withholdingCertificates,
} from "@constructos/db";
import type { TaxRegime } from "@constructos/shared";
import type { Db } from "../../lib/db.js";
import { appendLedger } from "../../lib/ledger.js";
import { forEachCompany } from "../../lib/scheduler.js";
import { addDaysISO } from "../field/dates.js";
import { pushNotifications } from "../notifications/service.js";
import { findTaxRegime } from "./regimes.js";
import {
  closeSignalByKey,
  raiseSignalOnce,
  recomputeExposure,
  setObligationStatus,
} from "./service.js";

/**
 * Tax risk sweeps — spec Vol II Domain Q: the "tax risk signals" the work
 * package asks for (missing registration on a paying vendor, withholding not
 * deducted, reverse charge misapplied, return overdue, verification lapsed)
 * plus the PE day-count recompute (#806). Every sweep is idempotent: a
 * signal is keyed in evidenceRefs.key and raised once; a condition that
 * clears closes its own signal.
 *
 * Registered with the platform scheduler as `tax.risk-sweep` and
 * `tax.pe-exposure`; also runnable on demand from the risks tab.
 */

export interface SweepCounts {
  overduePeriods: number;
  verificationsExpired: number;
  missingRegistrations: number;
  missingRegistrationsCleared: number;
  whtNotDeducted: number;
  signalsRaised: number;
}

function today(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Overdue returns: flip the period, breach the obligation, raise HIGH (#803). */
export async function sweepTaxPeriods(db: Db, companyId: string, now: Date): Promise<{ overdue: number; raised: number }> {
  const todayIso = today(now);
  const rows = await db
    .select()
    .from(taxPeriods)
    .where(
      and(
        eq(taxPeriods.companyId, companyId),
        inArray(taxPeriods.status, ["open", "closed"]),
        lt(taxPeriods.dueDate, todayIso),
      ),
    );
  let raised = 0;
  for (const p of rows) {
    await db
      .update(taxPeriods)
      .set({ status: "overdue", updatedAt: now.toISOString() })
      .where(and(eq(taxPeriods.id, p.id), inArray(taxPeriods.status, ["open", "closed"])));
    await setObligationStatus(db, p.obligationId, "open", "breached");
    const def = findTaxRegime(p.regime);
    const res = await raiseSignalOnce(db, {
      companyId,
      projectId: p.projectId,
      detector: "tax_return_overdue",
      key: `return_overdue:${p.id}`,
      severity: "high",
      confidence: 1,
      title: `Tax return overdue — ${p.returnKind.replace(/_/g, " ")} ${p.periodStart} to ${p.periodEnd}`,
      explanation:
        `The ${p.returnKind.replace(/_/g, " ")} return for ${p.periodStart}–${p.periodEnd} under ${def?.name ?? p.regime} was due on ${p.dueDate} and has not been filed. ` +
        `Late filing attracts penalties and, for deduction schemes, can cost the payee its credit. File and record the filing reference.`,
      evidenceRefs: { periodId: p.id, dueDate: p.dueDate, returnKind: p.returnKind },
    });
    if (res.raised) {
      raised += 1;
      await pushNotifications(db, [
        {
          companyId,
          userId: p.createdBy,
          projectId: p.projectId,
          kind: "tax",
          title: `Tax return overdue: ${p.returnKind.replace(/_/g, " ")} ${p.periodStart}–${p.periodEnd}`,
          body: `Due ${p.dueDate}. Not filed.`,
          recordType: "tax_period",
          recordId: p.id,
        },
      ]);
      await appendLedger(db, {
        companyId,
        actorId: null,
        action: "state_change",
        objectType: "tax_period",
        objectId: p.id,
        payload: { from: p.status, to: "overdue", dueDate: p.dueDate },
        projectId: p.projectId,
      });
    }
  }
  return { overdue: rows.length, raised };
}

/** Verifications that have aged past the regime's validity (UK CIS: two tax years). */
export async function sweepVerificationExpiry(db: Db, companyId: string, now: Date): Promise<{ expired: number }> {
  const rows = await db
    .select()
    .from(taxRegistrations)
    .where(
      and(
        eq(taxRegistrations.companyId, companyId),
        eq(taxRegistrations.verificationStatus, "verified"),
        isNotNull(taxRegistrations.verifiedAt),
      ),
    );
  let expired = 0;
  for (const r of rows) {
    const validity = findTaxRegime(r.regime)?.withholding?.verificationValidityDays ?? null;
    if (!validity || !r.verifiedAt) continue;
    const expiresAt = addDaysISO(r.verifiedAt.slice(0, 10), validity);
    if (expiresAt >= today(now)) continue;
    await db
      .update(taxRegistrations)
      .set({ verificationStatus: "expired", updatedAt: now.toISOString() })
      .where(and(eq(taxRegistrations.id, r.id), eq(taxRegistrations.verificationStatus, "verified")));
    expired += 1;
    await raiseSignalOnce(db, {
      companyId,
      projectId: null,
      detector: "tax_verification_expired",
      key: `verification_expired:${r.id}:${r.verifiedAt}`,
      severity: "medium",
      confidence: 1,
      title: `${r.kind.toUpperCase()} verification lapsed — ${r.holderName}`,
      explanation:
        `${r.holderName}'s ${r.kind.toUpperCase()} registration under ${findTaxRegime(r.regime)?.name ?? r.regime} was verified on ${r.verifiedAt.slice(0, 10)}; ` +
        `the verification is only good for ${validity} days and lapsed on ${expiresAt}. Until re-verified the unmatched deduction rate applies to payments.`,
      evidenceRefs: { registrationId: r.id, verifiedAt: r.verifiedAt, expiresAt },
    });
    await appendLedger(db, {
      companyId,
      actorId: null,
      action: "state_change",
      objectType: "tax_registration",
      objectId: r.id,
      payload: { verificationStatus: { from: "verified", to: "expired" }, expiresAt },
    });
  }
  return { expired };
}

/**
 * A vendor being paid under an approved commitment on a profiled project
 * with no active registration of any kind under that regime. The signal
 * closes itself once a registration is recorded.
 */
export async function sweepMissingRegistrations(
  db: Db,
  companyId: string,
  now: Date,
): Promise<{ raised: number; cleared: number }> {
  const profiles = await db
    .select({ projectId: taxProjectProfiles.projectId, regime: taxProjectProfiles.regime })
    .from(taxProjectProfiles)
    .where(eq(taxProjectProfiles.companyId, companyId));
  let raised = 0;
  let cleared = 0;
  const todayIso = today(now);
  for (const p of profiles) {
    const def = findTaxRegime(p.regime);
    if (!def || def.regime === "custom") continue;
    const paying = await db
      .select({ vendorId: commitments.vendorId })
      .from(commitments)
      .where(
        and(
          eq(commitments.companyId, companyId),
          eq(commitments.projectId, p.projectId),
          inArray(commitments.status, ["approved", "complete"]),
          isNotNull(commitments.vendorId),
        ),
      );
    const vendorIds = [...new Set(paying.map((c) => c.vendorId).filter((v): v is string => Boolean(v)))];
    if (vendorIds.length === 0) continue;
    const regs = await db
      .select({
        holderId: taxRegistrations.holderId,
        holderName: taxRegistrations.holderName,
        status: taxRegistrations.status,
        validTo: taxRegistrations.validTo,
      })
      .from(taxRegistrations)
      .where(
        and(
          eq(taxRegistrations.companyId, companyId),
          eq(taxRegistrations.holderType, "vendor"),
          eq(taxRegistrations.regime, p.regime as TaxRegime),
          inArray(taxRegistrations.holderId, vendorIds),
        ),
      );
    const covered = new Set(
      regs
        .filter((r) => r.status === "active" && (!r.validTo || r.validTo >= todayIso))
        .map((r) => r.holderId),
    );
    for (const vendorId of vendorIds) {
      const key = `missing_registration:${p.projectId}:${vendorId}`;
      if (covered.has(vendorId)) {
        if (await closeSignalByKey(db, companyId, p.projectId, "tax_missing_registration", key, "Auto-closed: an active registration is now on file.")) {
          cleared += 1;
        }
        continue;
      }
      const res = await raiseSignalOnce(db, {
        companyId,
        projectId: p.projectId,
        detector: "tax_missing_registration",
        key,
        severity: "high",
        confidence: 0.9,
        title: `Paying a vendor with no ${def.indirectTax.name.split(" ")[0] ?? "tax"} registration on file`,
        explanation:
          `A vendor with an approved commitment on this project has no active tax registration recorded under ${def.name}. ` +
          `Without a registration the platform cannot determine whether VAT may be charged${def.withholding?.registrationDriven ? ` or which ${def.withholding.name} rate applies` : ""}; ` +
          `payments to an unverified payee attract the unmatched deduction rate and the paying party carries the liability. Record and verify the registration (#800–801).`,
        evidenceRefs: { vendorId, regime: p.regime },
      });
      if (res.raised) raised += 1;
    }
  }
  return { raised, cleared };
}

/**
 * An issued payment to a vendor whose current determination on the project
 * requires a deduction, with no withholding certificate against the payment.
 * Bounded to the last 180 days of payments.
 */
export async function sweepWhtNotDeducted(db: Db, companyId: string, now: Date): Promise<{ raised: number }> {
  const profiles = await db
    .select({ projectId: taxProjectProfiles.projectId, regime: taxProjectProfiles.regime })
    .from(taxProjectProfiles)
    .where(eq(taxProjectProfiles.companyId, companyId));
  let raised = 0;
  const since = addDaysISO(today(now), -180);
  for (const p of profiles) {
    const payments = await db
      .select({
        id: commitmentPayments.id,
        vendorId: commitmentPayments.vendorId,
        amount: commitmentPayments.amount,
        currency: commitmentPayments.currency,
        paymentDate: commitmentPayments.paymentDate,
        reference: commitmentPayments.reference,
      })
      .from(commitmentPayments)
      .where(
        and(
          eq(commitmentPayments.companyId, companyId),
          eq(commitmentPayments.projectId, p.projectId),
          inArray(commitmentPayments.status, ["issued", "cleared"]),
          isNotNull(commitmentPayments.vendorId),
          gte(commitmentPayments.paymentDate, since),
        ),
      );
    for (const pay of payments) {
      if (!pay.vendorId) continue;
      const [det] = await db
        .select({
          id: taxDeterminations.id,
          withholdingAmount: taxDeterminations.withholdingAmount,
          withholdingRate: taxDeterminations.withholdingRate,
          withholdingScheme: taxDeterminations.withholdingScheme,
        })
        .from(taxDeterminations)
        .where(
          and(
            eq(taxDeterminations.companyId, companyId),
            eq(taxDeterminations.projectId, p.projectId),
            eq(taxDeterminations.vendorId, pay.vendorId),
            eq(taxDeterminations.status, "determined"),
            ne(taxDeterminations.withholdingScheme, "none"),
          ),
        )
        .orderBy(desc(taxDeterminations.createdAt))
        .limit(1);
      if (!det || det.withholdingAmount <= 0) continue;
      const [cert] = await db
        .select({ id: withholdingCertificates.id })
        .from(withholdingCertificates)
        .where(
          and(
            eq(withholdingCertificates.paymentId, pay.id),
            ne(withholdingCertificates.status, "cancelled"),
          ),
        )
        .limit(1);
      if (cert) continue;
      const res = await raiseSignalOnce(db, {
        companyId,
        projectId: p.projectId,
        detector: "tax_wht_not_deducted",
        key: `wht_not_deducted:${pay.id}`,
        severity: "high",
        confidence: 0.85,
        title: `Payment issued without a ${det.withholdingScheme.toUpperCase()} deduction certificate`,
        explanation:
          `Payment ${pay.reference} (${pay.currency} ${pay.amount.toFixed(2)}${pay.paymentDate ? `, ${pay.paymentDate}` : ""}) was issued to a vendor whose current determination on this project requires a ${det.withholdingRate}% ${det.withholdingScheme.toUpperCase()} deduction, ` +
          `but no withholding certificate is recorded against the payment. If the deduction was not made, the paying party is liable for it (#802, #804).`,
        evidenceRefs: { paymentId: pay.id, determinationId: det.id, vendorId: pay.vendorId },
      });
      if (res.raised) raised += 1;
    }
  }
  return { raised };
}

export async function sweepPeExposures(db: Db, companyId: string, now: Date): Promise<{ recomputed: number; raised: number }> {
  const rows = await db
    .select()
    .from(peExposures)
    .where(and(eq(peExposures.companyId, companyId), ne(peExposures.status, "closed")));
  let raised = 0;
  for (const row of rows) {
    const res = await recomputeExposure(db, row, today(now));
    if (res.signalRaised) raised += 1;
    if (res.row.status !== res.previousStatus) {
      await appendLedger(db, {
        companyId,
        actorId: null,
        action: "state_change",
        objectType: "pe_exposure",
        objectId: row.id,
        payload: { from: res.previousStatus, to: res.row.status, daysInWindow: res.row.daysInWindow },
        projectId: row.projectId,
      });
    }
  }
  return { recomputed: rows.length, raised };
}

export async function runTaxRiskSweep(db: Db, companyId: string, now: Date): Promise<SweepCounts> {
  const periods = await sweepTaxPeriods(db, companyId, now);
  const ver = await sweepVerificationExpiry(db, companyId, now);
  const missing = await sweepMissingRegistrations(db, companyId, now);
  const wht = await sweepWhtNotDeducted(db, companyId, now);
  return {
    overduePeriods: periods.overdue,
    verificationsExpired: ver.expired,
    missingRegistrations: missing.raised,
    missingRegistrationsCleared: missing.cleared,
    whtNotDeducted: wht.raised,
    signalsRaised: periods.raised + ver.expired + missing.raised + wht.raised,
  };
}

export function registerTaxJobs(app: FastifyInstance): void {
  app.scheduler.register({
    name: "tax.risk-sweep",
    description:
      "Overdue tax returns, lapsed verifications, unregistered paying vendors and payments issued without a deduction certificate",
    everyMs: 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) => forEachCompany(db, (companyId) => runTaxRiskSweep(db, companyId, now)),
  });
  app.scheduler.register({
    name: "tax.pe-exposure",
    description: "Recompute permanent-establishment day counts in their rolling windows and raise threshold signals",
    everyMs: 6 * 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) => forEachCompany(db, (companyId) => sweepPeExposures(db, companyId, now)),
  });
}
