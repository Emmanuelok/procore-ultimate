/**
 * Portfolio and commercial-structure sweeps, registered with the platform
 * scheduler (plan §6.1). Spec Vol II Domain G #426/#433 (affordability and
 * appropriation control), Domain Z #1053 (framework ceilings), #1059 (partner
 * contributions), #1062 (target cost), #1063–#1066 (open book, audit rights,
 * disallowed cost).
 *
 * A portfolio control that only fires when someone opens the page is not a
 * control. Everything here runs on a timer AND is exposed as
 * `POST /api/v1/portfolio/sweeps/run` for operators and tests.
 *
 * Every sweep is idempotent: each finding carries a deterministic key and
 * `raiseSignalOnce` refuses to raise a second signal for the same condition;
 * a condition that clears closes its own signal.
 */
import type { FastifyInstance } from "fastify";
import { and, eq, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import {
  auditRightsExecutions,
  disallowedCosts,
  frameworkAgreements,
  frameworkLots,
  jointVentures,
  jvTransactions,
  openBookVerifications,
  portfolioAppropriations,
  portfolioEnvelopes,
  portfolioFundingSources,
  targetCostContracts,
} from "@constructos/db";
import type { Db } from "../../lib/db.js";
import { appendLedger } from "../../lib/ledger.js";
import { forEachCompany } from "../../lib/scheduler.js";
import { pushNotifications } from "../notifications/service.js";
import {
  UNRESOLVED_DISALLOWED_STATUSES,
  closeSignalByKey,
  loadAllocations,
  loadCallOffs,
  raiseSignalOnce,
  setObligationStatus,
} from "./service.js";
import {
  affordability,
  appropriationPosition,
  fundingSourcePosition,
  type AppropriationRow,
  type EnvelopeRow,
} from "./rollup.js";
import { frameworkUtilisation, type FrameworkRow, type LotRow } from "./frameworks.js";
import { computePainGain, parseParticipants, parseShareBands } from "./paingain.js";

const todayISO = (now: Date): string => now.toISOString().slice(0, 10);

export interface SweepCounts {
  envelopeBreaches: number;
  appropriationOvercommits: number;
  fundingOverdrawn: number;
  frameworkCeilingBreaches: number;
  frameworksExpiring: number;
  jvContributionsOverdue: number;
  targetCostOverruns: number;
  verificationsOverdue: number;
  disallowedUnresolved: number;
  auditRightsObstructed: number;
  signalsRaised: number;
  signalsClosed: number;
}

const emptyCounts = (): SweepCounts => ({
  envelopeBreaches: 0,
  appropriationOvercommits: 0,
  fundingOverdrawn: 0,
  frameworkCeilingBreaches: 0,
  frameworksExpiring: 0,
  jvContributionsOverdue: 0,
  targetCostOverruns: 0,
  verificationsOverdue: 0,
  disallowedUnresolved: 0,
  auditRightsObstructed: 0,
  signalsRaised: 0,
  signalsClosed: 0,
});

/* ================================================================== */
/* Funding control (#426, #427, #433)                                  */
/* ================================================================== */

/**
 * Affordability envelopes, appropriation overcommitment and overdrawn
 * facilities. All three are company-level: the signal carries no projectId
 * because the breach is a portfolio fact, not a project one.
 */
export async function sweepFundingControl(
  db: Db,
  companyId: string,
  now: Date,
): Promise<SweepCounts> {
  const counts = emptyCounts();
  const allocations = await loadAllocations(db, companyId);

  const envelopeRows = await db
    .select()
    .from(portfolioEnvelopes)
    .where(and(eq(portfolioEnvelopes.companyId, companyId), eq(portfolioEnvelopes.status, "active")));
  const envelopes: EnvelopeRow[] = envelopeRows.map((e) => ({
    id: e.id,
    name: e.name,
    portfolioId: e.portfolioId,
    fiscalYear: e.fiscalYear,
    currency: e.currency,
    envelopeAmount: e.envelopeAmount,
    expenditureClass: e.expenditureClass,
    status: e.status,
    basis: e.basis,
  }));
  const afford = affordability(envelopes, allocations);
  for (const line of afford.lines) {
    const key = `envelope:${line.envelopeId}`;
    if (line.breached) {
      const res = await raiseSignalOnce(db, {
        companyId,
        projectId: null,
        detector: "portfolio_envelope_breach",
        key,
        severity: "high",
        confidence: 1,
        title: `Portfolio demand exceeds the ${line.fiscalYear} affordability envelope`,
        explanation:
          `Allocations of ${line.demand} ${line.currency} against "${line.name}" exceed its ${line.envelope} ${line.currency} ceiling by ${line.breachedBy} ${line.currency}. ` +
          `${line.allocationCount} allocation(s) in ${line.expenditureClass} expenditure are counted. ` +
          `Either the envelope must move — with the basis recorded — or allocations must be deferred.`,
        evidenceRefs: {
          envelopeId: line.envelopeId,
          fiscalYear: line.fiscalYear,
          currency: line.currency,
          envelope: line.envelope,
          demand: line.demand,
          breachedBy: line.breachedBy,
        },
      });
      if (res.raised) {
        counts.envelopeBreaches += 1;
        counts.signalsRaised += 1;
        await appendLedger(db, {
          companyId,
          actorId: null,
          action: "state_change",
          objectType: "portfolio_envelope",
          objectId: line.envelopeId,
          payload: { breached: true, demand: line.demand, envelope: line.envelope, breachedBy: line.breachedBy },
          storePayload: true,
        });
      }
    } else if (await closeSignalByKey(db, companyId, null, "portfolio_envelope_breach", key, "Demand fell back inside the envelope.")) {
      counts.signalsClosed += 1;
    }
  }

  const appropriationRows = await db
    .select()
    .from(portfolioAppropriations)
    .where(
      and(
        eq(portfolioAppropriations.companyId, companyId),
        inArray(portfolioAppropriations.status, ["approved", "committed"]),
      ),
    );
  for (const row of appropriationRows) {
    const appropriation: AppropriationRow = {
      id: row.id,
      fiscalYear: row.fiscalYear,
      currency: row.currency,
      appropriatedAmount: row.appropriatedAmount,
      carriedForwardIn: row.carriedForwardIn,
      carriedForwardOut: row.carriedForwardOut,
      virementNet: row.virementNet,
      status: row.status,
      carryForwardPolicy: row.carryForwardPolicy,
      expenditureClass: row.expenditureClass,
    };
    const position = appropriationPosition(appropriation, allocations);
    const key = `appropriation:${row.id}`;
    if (position.overcommitted) {
      const res = await raiseSignalOnce(db, {
        companyId,
        projectId: null,
        detector: "portfolio_appropriation_overcommitted",
        key,
        severity: "high",
        confidence: 1,
        title: `Appropriation "${row.name}" is overcommitted`,
        explanation:
          `Allocations of ${position.allocated} ${position.currency} exceed the ${position.authorised} ${position.currency} authorised for ${row.fiscalYear} by ${position.overcommittedBy} ${position.currency}. ` +
          `Authority = appropriated ${row.appropriatedAmount} + carried in ${row.carriedForwardIn} + net virement ${row.virementNet} − carried out ${row.carriedForwardOut}. ` +
          `A virement or a fresh appropriation is needed before further commitment.`,
        evidenceRefs: {
          appropriationId: row.id,
          fiscalYear: row.fiscalYear,
          authorised: position.authorised,
          allocated: position.allocated,
          overcommittedBy: position.overcommittedBy,
        },
      });
      if (res.raised) {
        counts.appropriationOvercommits += 1;
        counts.signalsRaised += 1;
      }
    } else if (
      await closeSignalByKey(db, companyId, null, "portfolio_appropriation_overcommitted", key, "Allocations fell back inside the authorised amount.")
    ) {
      counts.signalsClosed += 1;
    }
  }

  const sources = await db
    .select()
    .from(portfolioFundingSources)
    .where(
      and(
        eq(portfolioFundingSources.companyId, companyId),
        inArray(portfolioFundingSources.status, ["committed", "available"]),
      ),
    );
  for (const source of sources) {
    const position = fundingSourcePosition(
      {
        id: source.id,
        currency: source.currency,
        amount: source.amount,
        status: source.status,
        expenditureClass: source.expenditureClass,
      },
      allocations,
    );
    const key = `funding:${source.id}`;
    if (position.overdrawn) {
      const res = await raiseSignalOnce(db, {
        companyId,
        projectId: null,
        detector: "portfolio_funding_source_overdrawn",
        key,
        severity: "high",
        confidence: 1,
        title: `Funding source "${source.name}" is over-allocated`,
        explanation:
          `Allocations of ${position.allocated} ${position.currency} exceed the ${position.facility} ${position.currency} facility by ${position.overdrawnBy} ${position.currency}. ` +
          `${position.drawn} ${position.currency} has been drawn to date.`,
        evidenceRefs: {
          fundingSourceId: source.id,
          facility: position.facility,
          allocated: position.allocated,
          overdrawnBy: position.overdrawnBy,
        },
      });
      if (res.raised) {
        counts.fundingOverdrawn += 1;
        counts.signalsRaised += 1;
      }
    } else if (
      await closeSignalByKey(db, companyId, null, "portfolio_funding_source_overdrawn", key, "Allocations fell back inside the facility.")
    ) {
      counts.signalsClosed += 1;
    }
    /* An exhausted facility is a fact worth recording on the row itself so
       the register is honest without a second query. */
    const shouldBeExhausted = position.headroom <= 0.005 && source.amount > 0;
    if (shouldBeExhausted && source.status !== "exhausted") {
      await db
        .update(portfolioFundingSources)
        .set({ status: "exhausted", updatedAt: now.toISOString() })
        .where(eq(portfolioFundingSources.id, source.id));
      await appendLedger(db, {
        companyId,
        actorId: null,
        action: "state_change",
        objectType: "portfolio_funding_source",
        objectId: source.id,
        payload: { from: source.status, to: "exhausted", allocated: position.allocated, facility: position.facility },
      });
    }
  }

  return counts;
}

/* ================================================================== */
/* Framework ceilings and expiry (#1053)                               */
/* ================================================================== */

export async function sweepFrameworks(db: Db, companyId: string, now: Date): Promise<SweepCounts> {
  const counts = emptyCounts();
  const today = todayISO(now);
  const frameworks = await db
    .select()
    .from(frameworkAgreements)
    .where(and(eq(frameworkAgreements.companyId, companyId), inArray(frameworkAgreements.status, ["live", "suspended"])));
  if (frameworks.length === 0) return counts;

  const lotRows = await db.select().from(frameworkLots).where(eq(frameworkLots.companyId, companyId));

  for (const fw of frameworks) {
    const framework: FrameworkRow = {
      id: fw.id,
      reference: fw.reference,
      title: fw.title,
      currency: fw.currency,
      maximumValue: fw.maximumValue,
      startDate: fw.startDate,
      endDate: fw.endDate,
      extensionToDate: fw.extensionToDate,
      awardMode: fw.awardMode,
      directAwardThreshold: fw.directAwardThreshold,
      status: fw.status,
    };
    const lots: LotRow[] = lotRows
      .filter((l) => l.frameworkId === fw.id)
      .map((l) => ({
        id: l.id,
        frameworkId: l.frameworkId,
        lotNumber: l.lotNumber,
        title: l.title,
        currency: l.currency,
        ceilingValue: l.ceilingValue,
        awardMode: l.awardMode,
        status: l.status,
      }));
    const callOffs = await loadCallOffs(db, companyId, { frameworkId: fw.id });
    const utilisation = frameworkUtilisation(framework, lots, callOffs, today);

    const key = `framework:${fw.id}`;
    if (utilisation.breached) {
      const res = await raiseSignalOnce(db, {
        companyId,
        projectId: null,
        detector: "framework_ceiling_breach",
        key,
        severity: "high",
        confidence: 1,
        title: `Framework ${fw.reference} has been called off beyond its ceiling`,
        explanation:
          `Call-offs of ${utilisation.ordered} ${utilisation.currency} exceed the framework's ${utilisation.ceiling} ${utilisation.currency} maximum by ${utilisation.breachedBy} ${utilisation.currency} across ${utilisation.callOffCount} order(s). ` +
          `Calling off beyond a declared framework maximum is outside the agreement and is challengeable.`,
        evidenceRefs: {
          frameworkId: fw.id,
          ceiling: utilisation.ceiling,
          ordered: utilisation.ordered,
          breachedBy: utilisation.breachedBy,
        },
      });
      if (res.raised) {
        counts.frameworkCeilingBreaches += 1;
        counts.signalsRaised += 1;
      }
    } else if (await closeSignalByKey(db, companyId, null, "framework_ceiling_breach", key, "Framework consumption fell back inside the ceiling.")) {
      counts.signalsClosed += 1;
    }

    for (const lot of utilisation.lots) {
      const lotKey = `framework_lot:${lot.lotId}`;
      if (lot.breached) {
        const res = await raiseSignalOnce(db, {
          companyId,
          projectId: null,
          detector: "framework_ceiling_breach",
          key: lotKey,
          severity: "medium",
          confidence: 1,
          title: `Lot ${lot.lotNumber} of framework ${fw.reference} is over its ceiling`,
          explanation:
            `Call-offs of ${lot.ordered} ${lot.currency} against "${lot.title}" exceed its ${lot.ceiling} ${lot.currency} ceiling by ${lot.breachedBy} ${lot.currency}.`,
          evidenceRefs: { frameworkId: fw.id, lotId: lot.lotId, ceiling: lot.ceiling, ordered: lot.ordered },
        });
        if (res.raised) {
          counts.frameworkCeilingBreaches += 1;
          counts.signalsRaised += 1;
        }
      } else if (await closeSignalByKey(db, companyId, null, "framework_ceiling_breach", lotKey, "Lot consumption fell back inside the ceiling.")) {
        counts.signalsClosed += 1;
      }
    }

    const expiryKey = `framework_expiry:${fw.id}`;
    const daysToExpiry = utilisation.daysToExpiry;
    if (daysToExpiry !== null && daysToExpiry <= 90) {
      const res = await raiseSignalOnce(db, {
        companyId,
        projectId: null,
        detector: "framework_expiring",
        key: expiryKey,
        severity: daysToExpiry < 0 ? "high" : utilisation.liveCallOffsAtExpiry > 0 ? "medium" : "low",
        confidence: 1,
        title:
          daysToExpiry < 0
            ? `Framework ${fw.reference} expired on ${utilisation.expiresOn}`
            : `Framework ${fw.reference} expires in ${daysToExpiry} day(s)`,
        explanation:
          `${fw.title} ${daysToExpiry < 0 ? "expired" : "expires"} on ${utilisation.expiresOn}. ` +
          `${utilisation.liveCallOffsAtExpiry} call-off(s) are still live against it. ` +
          `Work cannot be called off a framework that has ended; extend it, replace it, or novate the live orders.`,
        evidenceRefs: {
          frameworkId: fw.id,
          expiresOn: utilisation.expiresOn,
          daysToExpiry,
          liveCallOffs: utilisation.liveCallOffsAtExpiry,
        },
      });
      if (res.raised) {
        counts.frameworksExpiring += 1;
        counts.signalsRaised += 1;
      }
      if (daysToExpiry < 0 && fw.status === "live") {
        await db
          .update(frameworkAgreements)
          .set({ status: "expired", updatedAt: now.toISOString() })
          .where(and(eq(frameworkAgreements.id, fw.id), eq(frameworkAgreements.status, "live")));
        await appendLedger(db, {
          companyId,
          actorId: null,
          action: "state_change",
          objectType: "framework_agreement",
          objectId: fw.id,
          payload: { from: "live", to: "expired", expiresOn: utilisation.expiresOn },
        });
      }
    }
  }
  return counts;
}

/* ================================================================== */
/* Commercial structures (#1059, #1062, #1063, #1064, #1066)           */
/* ================================================================== */

export async function sweepCommercialStructures(
  db: Db,
  companyId: string,
  now: Date,
): Promise<SweepCounts> {
  const counts = emptyCounts();
  const today = todayISO(now);

  /* --- JV contributions called and unpaid past their due date (#1059) --- */
  const overdueTx = await db
    .select()
    .from(jvTransactions)
    .where(
      and(
        eq(jvTransactions.companyId, companyId),
        eq(jvTransactions.status, "called"),
        isNotNull(jvTransactions.dueDate),
        lt(jvTransactions.dueDate, today),
      ),
    );
  if (overdueTx.length > 0) {
    const ventures = await db
      .select()
      .from(jointVentures)
      .where(eq(jointVentures.companyId, companyId));
    const ventureById = new Map(ventures.map((v) => [v.id, v]));
    for (const t of overdueTx) {
      const venture = ventureById.get(t.jvId);
      if (!venture) continue;
      await db
        .update(jvTransactions)
        .set({ status: "overdue", updatedAt: now.toISOString() })
        .where(and(eq(jvTransactions.id, t.id), eq(jvTransactions.status, "called")));
      await setObligationStatus(db, t.obligationId, "open", "breached");
      const res = await raiseSignalOnce(db, {
        companyId,
        projectId: venture.projectId,
        detector: "jv_contribution_overdue",
        key: `jv_tx:${t.id}`,
        severity: "high",
        confidence: 1,
        title: `Partner contribution overdue in ${venture.name}`,
        explanation:
          `A ${t.kind.replace(/_/g, " ")} of ${t.amount} ${t.currency} was due on ${t.dueDate} and has not been settled. ` +
          `An unmet capital call shifts the venture's working capital onto the other partners and may trigger default provisions in the deed.`,
        evidenceRefs: { jvId: t.jvId, transactionId: t.id, partnerId: t.partnerId, dueDate: t.dueDate, amount: t.amount, currency: t.currency },
      });
      if (res.raised) {
        counts.jvContributionsOverdue += 1;
        counts.signalsRaised += 1;
        await pushNotifications(db, [
          {
            companyId,
            userId: t.createdBy,
            projectId: venture.projectId,
            kind: "portfolio",
            title: `Partner contribution overdue: ${venture.name}`,
            body: `${t.amount} ${t.currency} was due ${t.dueDate}.`,
            recordType: "jv_transaction",
            recordId: t.id,
          },
        ]);
        await appendLedger(db, {
          companyId,
          actorId: null,
          action: "state_change",
          objectType: "jv_transaction",
          objectId: t.id,
          payload: { from: "called", to: "overdue", dueDate: t.dueDate },
          projectId: venture.projectId,
        });
      }
    }
  }

  /* --- Target cost forecast overrun (#1062) --- */
  const targets = await db
    .select()
    .from(targetCostContracts)
    .where(
      and(
        eq(targetCostContracts.companyId, companyId),
        inArray(targetCostContracts.status, ["active", "final_account"]),
      ),
    );
  for (const t of targets) {
    const outturn = t.forecastDefinedCost ?? t.actualDefinedCost;
    let bands;
    let participants;
    try {
      bands = parseShareBands(t.shareBands);
      participants = parseParticipants(t.participants);
    } catch {
      continue; // a malformed model is reported by the route, not by a sweep
    }
    const result = computePainGain({
      currency: t.currency,
      baseTargetCost: t.baseTargetCost,
      targetAdjustments: t.targetAdjustments,
      outturnCost: outturn,
      feePercent: t.feePercent,
      mechanism: t.mechanism as never,
      shareBands: bands,
      painCap: t.painCap,
      gainCap: t.gainCap,
      participants,
    });
    const key = `target_cost:${t.id}`;
    if (result.computable && result.side === "pain" && (result.variancePercent ?? 0) >= 2) {
      const res = await raiseSignalOnce(db, {
        companyId,
        projectId: t.projectId,
        detector: "target_cost_overrun",
        key,
        severity: (result.variancePercent ?? 0) >= 10 ? "high" : "medium",
        confidence: 0.9,
        title: `Target cost overrun forecast on ${t.name}`,
        explanation:
          `Forecast defined cost of ${result.outturnCost} ${t.currency} exceeds the adjusted target of ${result.adjustedTarget} ${t.currency} by ${result.variance} ${t.currency} (${result.variancePercent}%). ` +
          `Under the share mechanism the contractor bears ${result.contractorShare} ${t.currency} and the client ${result.clientShare} ${t.currency}.`,
        evidenceRefs: {
          targetCostId: t.id,
          adjustedTarget: result.adjustedTarget,
          outturn: result.outturnCost,
          variance: result.variance,
          contractorShare: result.contractorShare,
          clientShare: result.clientShare,
        },
      });
      if (res.raised) {
        counts.targetCostOverruns += 1;
        counts.signalsRaised += 1;
      }
    } else if (await closeSignalByKey(db, companyId, t.projectId, "target_cost_overrun", key, "The forecast returned to or below the adjusted target.")) {
      counts.signalsClosed += 1;
    }
  }

  /* --- Open-book verifications that were planned and have not started (#1063) --- */
  const overdueVerifications = await db
    .select()
    .from(openBookVerifications)
    .where(
      and(
        eq(openBookVerifications.companyId, companyId),
        eq(openBookVerifications.status, "planned"),
        isNotNull(openBookVerifications.plannedAt),
        lt(openBookVerifications.plannedAt, today),
      ),
    );
  for (const v of overdueVerifications) {
    const res = await raiseSignalOnce(db, {
      companyId,
      projectId: v.projectId,
      detector: "open_book_verification_overdue",
      key: `verification:${v.id}`,
      severity: "medium",
      confidence: 1,
      title: `Open-book verification ${v.reference} has not started`,
      explanation:
        `"${v.title}" was planned to start on ${v.plannedAt} and is still at "planned". ` +
        `${v.claimedAmount} ${v.currency} of claimed defined cost is untested. An audit right that is never exercised is not a control.`,
      evidenceRefs: { verificationId: v.id, plannedAt: v.plannedAt, claimed: v.claimedAmount, currency: v.currency },
    });
    if (res.raised) {
      counts.verificationsOverdue += 1;
      counts.signalsRaised += 1;
    }
  }

  /* --- Disallowed costs whose response deadline has passed (#1066) --- */
  const overdueDisallowed = await db
    .select()
    .from(disallowedCosts)
    .where(
      and(
        eq(disallowedCosts.companyId, companyId),
        inArray(disallowedCosts.status, UNRESOLVED_DISALLOWED_STATUSES),
        isNotNull(disallowedCosts.responseDueAt),
        lt(disallowedCosts.responseDueAt, today),
      ),
    );
  for (const d of overdueDisallowed) {
    await setObligationStatus(db, d.obligationId, "open", "breached");
    const res = await raiseSignalOnce(db, {
      companyId,
      projectId: d.projectId,
      detector: "disallowed_cost_unresolved",
      key: `disallowed:${d.id}`,
      severity: "medium",
      confidence: 1,
      title: `Disallowed cost DC-${d.number} has had no response`,
      explanation:
        `${d.amount} ${d.currency} was disallowed on ${d.raisedAt} under ${d.groundClause ?? "no stated clause"} and a response was due by ${d.responseDueAt}. ` +
        `Nothing has been recorded. An unresolved disallowance left to age becomes a final-account dispute.`,
      evidenceRefs: {
        disallowedCostId: d.id,
        amount: d.amount,
        currency: d.currency,
        responseDueAt: d.responseDueAt,
        category: d.category,
      },
    });
    if (res.raised) {
      counts.disallowedUnresolved += 1;
      counts.signalsRaised += 1;
    }
  }

  /* --- Audit rights: access not granted by the scheduled date (#1064) --- */
  const stalledAudits = await db
    .select()
    .from(auditRightsExecutions)
    .where(
      and(
        eq(auditRightsExecutions.companyId, companyId),
        inArray(auditRightsExecutions.status, ["notified", "scheduled", "obstructed"]),
        isNotNull(auditRightsExecutions.scheduledDate),
        lt(auditRightsExecutions.scheduledDate, today),
        isNull(auditRightsExecutions.accessGrantedAt),
      ),
    );
  for (const a of stalledAudits) {
    await setObligationStatus(db, a.obligationId, "open", "breached");
    const res = await raiseSignalOnce(db, {
      companyId,
      projectId: a.projectId,
      detector: "audit_rights_obstructed",
      key: `audit_rights:${a.id}`,
      severity: "high",
      confidence: 0.9,
      title: `Audit access not granted for ${a.reference}`,
      explanation:
        `The audit of ${a.subjectName} was scheduled for ${a.scheduledDate} under ${a.clause ?? "the contract's audit rights"} and no access has been recorded. ` +
        `Refusal or delay in producing records is itself a contractual breach and is evidence in any later dispute about defined cost.`,
      evidenceRefs: {
        auditId: a.id,
        subjectType: a.subjectType,
        subjectId: a.subjectId,
        scheduledDate: a.scheduledDate,
        clause: a.clause,
      },
    });
    if (res.raised) {
      counts.auditRightsObstructed += 1;
      counts.signalsRaised += 1;
      if (a.status !== "obstructed") {
        await db
          .update(auditRightsExecutions)
          .set({ status: "obstructed", updatedAt: now.toISOString() })
          .where(eq(auditRightsExecutions.id, a.id));
        await appendLedger(db, {
          companyId,
          actorId: null,
          action: "state_change",
          objectType: "audit_rights_execution",
          objectId: a.id,
          payload: { from: a.status, to: "obstructed", scheduledDate: a.scheduledDate },
          projectId: a.projectId,
        });
      }
    }
  }

  return counts;
}

function merge(into: SweepCounts, from: SweepCounts): SweepCounts {
  for (const key of Object.keys(into) as Array<keyof SweepCounts>) {
    into[key] += from[key];
  }
  return into;
}

/** Everything, for one company. Used by the manual run endpoint. */
export async function runPortfolioSweeps(db: Db, companyId: string, now: Date): Promise<SweepCounts> {
  const counts = emptyCounts();
  merge(counts, await sweepFundingControl(db, companyId, now));
  merge(counts, await sweepFrameworks(db, companyId, now));
  merge(counts, await sweepCommercialStructures(db, companyId, now));
  return counts;
}

/** Register the scheduler jobs (plan §6.1). Disabled under NODE_ENV=test. */
export function registerPortfolioJobs(app: FastifyInstance): void {
  app.scheduler.register({
    name: "portfolio.funding-control",
    description:
      "Affordability envelope breaches, overcommitted appropriations and over-allocated funding sources across the portfolio",
    everyMs: 6 * 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) => forEachCompany(db, (companyId) => sweepFundingControl(db, companyId, now)),
  });
  app.scheduler.register({
    name: "portfolio.frameworks",
    description: "Framework and lot ceiling breaches, and frameworks approaching or past expiry with live call-offs",
    everyMs: 6 * 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) => forEachCompany(db, (companyId) => sweepFrameworks(db, companyId, now)),
  });
  app.scheduler.register({
    name: "portfolio.commercial-structures",
    description:
      "Overdue JV contributions, target-cost overruns, unstarted open-book verifications, unanswered disallowed costs and obstructed audit rights",
    everyMs: 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) => forEachCompany(db, (companyId) => sweepCommercialStructures(db, companyId, now)),
  });
}
