/**
 * Attention sources — reads every module's tables for ONE company and
 * returns the candidates the attention engine ranks (Vol I §6.2 #741–748,
 * §7 #782–785; Vol II X #1011, #1017).
 *
 * Each source is one indexed query bounded by companyId, a status filter
 * and, for deadline-driven kinds, a date window; every query is capped so a
 * tenant with a million punch items cannot make the refresh unbounded. A
 * source that yields nothing is simply absent — the feed never fabricates.
 *
 * Money on a candidate is the amount in the record's own currency; it is
 * used as a magnitude multiplier by the engine and never summed.
 */
import { and, asc, eq, gte, inArray, isNotNull, lt, lte, sql } from "drizzle-orm";
import {
  aiReviewQueue,
  budgets,
  changeEvents,
  commitments,
  contractEvents,
  covenantReadings,
  covenants,
  insuranceCertificates,
  nonConformanceReports,
  obligations,
  paymentClaims,
  punchItems,
  rfis,
  safetyIncidents,
  schedules,
  signals,
  submittals,
} from "@constructos/db";
import type { AttentionSeverity } from "@constructos/shared";
import type { Db } from "../../lib/db.js";
import { daysUntil, severityForDeadline, type AttentionCandidate } from "./attention-engine.js";
import { daysBetweenIso, OPEN_SIGNAL_DISPOSITIONS } from "./health-inputs.js";

export interface ProjectLite {
  id: string;
  name: string;
  stage: string;
  currency: string;
  finishDate: string | null;
}

const DAY_MS = 86_400_000;
const SOURCE_LIMIT = 300;
const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const plusDays = (d: Date, days: number) => new Date(d.getTime() + days * DAY_MS);
/** ISO date (YYYY-MM-DD) → end-of-day ISO timestamp, so a date-only deadline is "due today" until midnight UTC. */
const dateToIso = (date: string | null): string | null => {
  if (!date) return null;
  if (date.length > 10) return date;
  const t = Date.parse(`${date}T23:59:59.999Z`);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const tsToIso = (ts: string | null): string | null => {
  if (!ts) return null;
  const t = Date.parse(ts);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const overdueText = (days: number | null) =>
  days === null ? "" : days < 0 ? `${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} overdue` : days === 0 ? "due today" : `due in ${days} day${days === 1 ? "" : "s"}`;

export async function collectAttentionCandidates(
  db: Db,
  companyId: string,
  projects: ProjectLite[],
  now: Date,
): Promise<AttentionCandidate[]> {
  const byId = new Map(projects.map((p) => [p.id, p] as const));
  const today = isoDate(now);
  const in14 = isoDate(plusDays(now, 14));
  const in30 = isoDate(plusDays(now, 30));
  const in14Iso = plusDays(now, 14).toISOString();
  const ago30Iso = plusDays(now, -30).toISOString();
  const out: AttentionCandidate[] = [];

  const base = (projectId: string | null) => {
    const p = projectId ? byId.get(projectId) : undefined;
    if (projectId && !p) return null; // template or foreign project — never surface it
    return { companyId, projectId, projectName: p?.name ?? null, currency: p?.currency ?? null };
  };

  /* --- obligations due / breached (#1008) --- */
  const obl = await db
    .select()
    .from(obligations)
    .where(
      and(
        eq(obligations.companyId, companyId),
        sql`(${obligations.status} = 'open' and ${obligations.deadline} is not null and ${obligations.deadline} <= ${in14Iso}) or (${obligations.status} = 'breached' and ${obligations.createdAt} >= ${ago30Iso})`,
      ),
    )
    .orderBy(asc(obligations.deadline))
    .limit(SOURCE_LIMIT);
  for (const o of obl) {
    const b = base(o.projectId);
    if (!b) continue;
    const dueAt = tsToIso(o.deadline);
    const breached = o.status === "breached";
    out.push({
      ...b,
      kind: "obligation_due",
      severity: breached ? "critical" : severityForDeadline(dueAt, now, "medium"),
      title: breached ? `Obligation breached: ${o.trigger}` : `Obligation due: ${o.trigger}`,
      detail: `${o.sourceClause}${dueAt ? ` — ${overdueText(daysUntil(dueAt, now))}` : ""}${o.evidenceRequirement ? `. Evidence required: ${o.evidenceRequirement}` : ""}`,
      dueAt,
      href: `/projects/${o.projectId}/contracts`,
      sourceType: "obligation",
      sourceId: o.id,
    });
  }

  /* --- contract time bars (#1006) --- */
  const ev = await db
    .select()
    .from(contractEvents)
    .where(
      and(
        eq(contractEvents.companyId, companyId),
        sql`(${contractEvents.status} = 'open' and ${contractEvents.noticeDeadline} is not null and ${contractEvents.noticeDeadline} <= ${in14}) or (${contractEvents.status} = 'time_barred' and ${contractEvents.updatedAt} >= ${ago30Iso})`,
      ),
    )
    .orderBy(asc(contractEvents.noticeDeadline))
    .limit(SOURCE_LIMIT);
  for (const e of ev) {
    const b = base(e.projectId);
    if (!b) continue;
    const dueAt = dateToIso(e.noticeDeadline);
    const barred = e.status === "time_barred";
    out.push({
      ...b,
      kind: "time_bar",
      severity: barred ? "critical" : severityForDeadline(dueAt, now, "high"),
      title: barred ? `Time-barred: ${e.title}` : `Notice deadline: ${e.title}`,
      detail: `${e.kind.replace(/_/g, " ")}${e.clauseRef ? ` under cl. ${e.clauseRef}` : ""}${dueAt ? ` — ${overdueText(daysUntil(dueAt, now))}` : ""}`,
      dueAt,
      href: `/projects/${e.projectId}/contracts/${e.contractId}`,
      sourceType: "contract_event",
      sourceId: e.id,
      money: e.costImpactEstimate ?? null,
    });
  }

  /* --- integrity signals (#1011) --- */
  const sig = await db
    .select()
    .from(signals)
    .where(
      and(
        eq(signals.companyId, companyId),
        inArray(signals.disposition, OPEN_SIGNAL_DISPOSITIONS),
        inArray(signals.severity, ["critical", "high"]),
      ),
    )
    .orderBy(sql`${signals.createdAt} desc`)
    .limit(SOURCE_LIMIT);
  for (const s of sig) {
    const b = base(s.projectId);
    if (!b) continue;
    out.push({
      ...b,
      kind: "signal",
      severity: s.severity === "critical" ? "critical" : "high",
      title: s.title,
      detail: `${s.detector} · confidence ${Math.round(s.confidence * 100)}% · ${s.disposition.replace(/_/g, " ")}`,
      dueAt: null,
      href: s.projectId ? `/projects/${s.projectId}/assurance` : "/assurance",
      sourceType: "signal",
      sourceId: s.id,
    });
  }

  /* --- statutory payment claims --- */
  const claims = await db
    .select()
    .from(paymentClaims)
    .where(
      and(
        eq(paymentClaims.companyId, companyId),
        sql`(${paymentClaims.status} = 'served' and ${paymentClaims.responseDeadline} is not null and ${paymentClaims.responseDeadline} <= ${in14}) or ${paymentClaims.status} in ('deemed','suspended')`,
      ),
    )
    .orderBy(asc(paymentClaims.responseDeadline))
    .limit(SOURCE_LIMIT);
  for (const c of claims) {
    const b = base(c.projectId);
    if (!b) continue;
    const dueAt = dateToIso(c.status === "served" ? c.responseDeadline : c.finalPaymentDate);
    const sev: AttentionSeverity = c.status === "served" ? severityForDeadline(dueAt, now, "high") : "critical";
    out.push({
      ...b,
      kind: "payment_due",
      severity: sev,
      title: `Payment claim #${c.number} ${c.status === "served" ? "response due" : c.status}`,
      detail: `${c.regime} regime · ${c.claimedAmount.toLocaleString()} ${c.currency}${dueAt ? ` — ${overdueText(daysUntil(dueAt, now))}` : ""}`,
      dueAt,
      href: `/projects/${c.projectId}/payments`,
      sourceType: "payment_claim",
      sourceId: c.id,
      money: c.claimedAmount,
      currency: c.currency,
    });
  }

  /* --- overdue RFIs --- */
  const rfiRows = await db
    .select({ id: rfis.id, projectId: rfis.projectId, number: rfis.number, subject: rfis.subject, dueDate: rfis.dueDate, status: rfis.status })
    .from(rfis)
    .where(and(eq(rfis.companyId, companyId), inArray(rfis.status, ["open", "answered"]), isNotNull(rfis.dueDate), lt(rfis.dueDate, today)))
    .orderBy(asc(rfis.dueDate))
    .limit(SOURCE_LIMIT);
  for (const r of rfiRows) {
    const b = base(r.projectId);
    if (!b) continue;
    const dueAt = dateToIso(r.dueDate);
    const days = daysUntil(dueAt, now);
    out.push({
      ...b,
      kind: "overdue_rfi",
      severity: days !== null && days < -14 ? "high" : "medium",
      title: `RFI #${r.number} overdue: ${r.subject}`,
      detail: `${overdueText(days)} · ${r.status}`,
      dueAt,
      href: `/projects/${r.projectId}/rfis/${r.id}`,
      sourceType: "rfi",
      sourceId: r.id,
    });
  }

  /* --- overdue submittals --- */
  const subRows = await db
    .select({ id: submittals.id, projectId: submittals.projectId, number: submittals.number, title: submittals.title, submitByDate: submittals.submitByDate, status: submittals.status })
    .from(submittals)
    .where(and(eq(submittals.companyId, companyId), inArray(submittals.status, ["draft", "open"]), isNotNull(submittals.submitByDate), lt(submittals.submitByDate, today)))
    .orderBy(asc(submittals.submitByDate))
    .limit(SOURCE_LIMIT);
  for (const s of subRows) {
    const b = base(s.projectId);
    if (!b) continue;
    const dueAt = dateToIso(s.submitByDate);
    const days = daysUntil(dueAt, now);
    out.push({
      ...b,
      kind: "overdue_submittal",
      severity: days !== null && days < -14 ? "high" : "medium",
      title: `Submittal #${s.number} past submit-by: ${s.title}`,
      detail: `${overdueText(days)} · ${s.status}`,
      dueAt,
      href: `/projects/${s.projectId}/submittals/${s.id}`,
      sourceType: "submittal",
      sourceId: s.id,
    });
  }

  /* --- overdue punch (low, bounded) --- */
  const punchRows = await db
    .select({ id: punchItems.id, projectId: punchItems.projectId, number: punchItems.number, title: punchItems.title, dueDate: punchItems.dueDate, priority: punchItems.priority })
    .from(punchItems)
    .where(and(eq(punchItems.companyId, companyId), inArray(punchItems.status, ["open", "in_progress", "ready_for_review"]), isNotNull(punchItems.dueDate), lt(punchItems.dueDate, today)))
    .orderBy(asc(punchItems.dueDate))
    .limit(100);
  for (const p of punchRows) {
    const b = base(p.projectId);
    if (!b) continue;
    const dueAt = dateToIso(p.dueDate);
    out.push({
      ...b,
      kind: "punch_overdue",
      severity: p.priority === "high" ? "medium" : "low",
      title: `Punch #${p.number} overdue: ${p.title}`,
      detail: `${overdueText(daysUntil(dueAt, now))} · priority ${p.priority}`,
      dueAt,
      href: `/projects/${p.projectId}/punch`,
      sourceType: "punch_item",
      sourceId: p.id,
    });
  }

  /* --- open serious+ safety incidents --- */
  const inc = await db
    .select({ id: safetyIncidents.id, projectId: safetyIncidents.projectId, reference: safetyIncidents.reference, title: safetyIncidents.title, severity: safetyIncidents.severity, isFatality: safetyIncidents.isFatality, status: safetyIncidents.status, occurredAt: safetyIncidents.occurredAt, investigationDueDate: safetyIncidents.investigationDueDate })
    .from(safetyIncidents)
    .where(
      and(
        eq(safetyIncidents.companyId, companyId),
        sql`${safetyIncidents.status} not in ('closed','void')`,
        sql`(${safetyIncidents.severity} in ('serious','major','catastrophic') or ${safetyIncidents.isFatality} = 1)`,
      ),
    )
    .orderBy(sql`${safetyIncidents.occurredAt} desc`)
    .limit(SOURCE_LIMIT);
  for (const i of inc) {
    const b = base(i.projectId);
    if (!b) continue;
    const sev: AttentionSeverity = i.isFatality === 1 || i.severity === "catastrophic" || i.severity === "major" ? "critical" : "high";
    out.push({
      ...b,
      kind: "safety_incident",
      severity: sev,
      title: `${i.reference}: ${i.title}`,
      detail: `${i.isFatality === 1 ? "fatality" : i.severity} · ${i.status.replace(/_/g, " ")} · occurred ${isoDate(new Date(i.occurredAt))}`,
      dueAt: dateToIso(i.investigationDueDate),
      href: `/projects/${i.projectId}/safety`,
      sourceType: "safety_incident",
      sourceId: i.id,
    });
  }

  /* --- open major/critical NCRs --- */
  const ncrs = await db
    .select({ id: nonConformanceReports.id, projectId: nonConformanceReports.projectId, reference: nonConformanceReports.reference, title: nonConformanceReports.title, severity: nonConformanceReports.severity, status: nonConformanceReports.status, responseDueDate: nonConformanceReports.responseDueDate })
    .from(nonConformanceReports)
    .where(
      and(
        eq(nonConformanceReports.companyId, companyId),
        sql`${nonConformanceReports.status} not in ('closed','rejected','void')`,
        inArray(nonConformanceReports.severity, ["major", "critical"]),
      ),
    )
    .orderBy(asc(nonConformanceReports.responseDueDate))
    .limit(SOURCE_LIMIT);
  for (const q of ncrs) {
    const b = base(q.projectId);
    if (!b) continue;
    const dueAt = dateToIso(q.responseDueDate);
    out.push({
      ...b,
      kind: "ncr_open",
      severity: q.severity === "critical" ? "critical" : severityForDeadline(dueAt, now, "high"),
      title: `${q.reference}: ${q.title}`,
      detail: `${q.severity} NCR · ${q.status.replace(/_/g, " ")}${dueAt ? ` — response ${overdueText(daysUntil(dueAt, now))}` : ""}`,
      dueAt,
      href: `/projects/${q.projectId}/quality`,
      sourceType: "non_conformance_report",
      sourceId: q.id,
    });
  }

  /* --- schedule slip --- */
  const sched = await db
    .select({ id: schedules.id, projectId: schedules.projectId, name: schedules.name, computedFinish: schedules.computedFinish })
    .from(schedules)
    .where(and(eq(schedules.companyId, companyId), eq(schedules.isActive, 1), isNotNull(schedules.computedFinish)))
    .limit(SOURCE_LIMIT);
  for (const s of sched) {
    const p = byId.get(s.projectId);
    if (!p || !p.finishDate) continue;
    const slip = daysBetweenIso(p.finishDate, s.computedFinish);
    if (slip === null || slip <= 0) continue;
    out.push({
      companyId,
      projectId: s.projectId,
      projectName: p.name,
      currency: p.currency,
      kind: "schedule_slip",
      severity: slip > 30 ? "high" : "medium",
      title: `Schedule slips ${slip} day${slip === 1 ? "" : "s"}`,
      detail: `"${s.name}" forecasts finish ${s.computedFinish} against the project finish ${p.finishDate}`,
      dueAt: dateToIso(p.finishDate),
      href: `/projects/${s.projectId}/schedule`,
      sourceType: "schedule",
      sourceId: s.id,
    });
  }

  /* --- budget overrun --- */
  const bud = await db
    .select({ id: budgets.id, projectId: budgets.projectId, name: budgets.name, currency: budgets.currency, revised: budgets.revisedBudgetTotal, variance: budgets.varianceTotal })
    .from(budgets)
    .where(and(eq(budgets.companyId, companyId), eq(budgets.isActive, 1), lt(budgets.varianceTotal, 0)))
    .limit(SOURCE_LIMIT);
  for (const bg of bud) {
    const b = base(bg.projectId);
    if (!b) continue;
    const pct = bg.revised > 0 ? Math.round((Math.abs(bg.variance) / bg.revised) * 1000) / 10 : null;
    out.push({
      ...b,
      kind: "budget_overrun",
      severity: pct !== null && pct >= 5 ? "high" : "medium",
      title: `Budget "${bg.name}" forecasts an overrun`,
      detail: `Forecast final exceeds the revised budget by ${Math.abs(bg.variance).toLocaleString()} ${bg.currency}${pct !== null ? ` (${pct}%)` : ""}`,
      dueAt: null,
      href: `/projects/${bg.projectId}/budget`,
      sourceType: "budget",
      sourceId: bg.id,
      money: Math.abs(bg.variance),
      currency: bg.currency,
    });
  }

  /* --- commitments on payment hold --- */
  const holds = await db
    .select({ id: commitments.id, projectId: commitments.projectId, reference: commitments.reference, title: commitments.title, currency: commitments.currency, reason: commitments.complianceHoldReason, balance: commitments.balanceToFinish })
    .from(commitments)
    .where(and(eq(commitments.companyId, companyId), eq(commitments.paymentHold, 1), sql`${commitments.status} not in ('void','terminated','complete')`))
    .limit(SOURCE_LIMIT);
  for (const h of holds) {
    const b = base(h.projectId);
    if (!b) continue;
    out.push({
      ...b,
      kind: "invoice_hold",
      severity: "medium",
      title: `Payment hold on ${h.reference}: ${h.title}`,
      detail: h.reason ?? "Compliance hold — payments are blocked until it is cleared",
      dueAt: null,
      href: `/projects/${h.projectId}/commitments`,
      sourceType: "commitment",
      sourceId: h.id,
      money: h.balance,
      currency: h.currency,
    });
  }

  /* --- pending agent proposals (#1020) --- */
  const props = await db
    .select({ id: aiReviewQueue.id, projectId: aiReviewQueue.projectId, targetType: aiReviewQueue.targetType, summary: aiReviewQueue.summary, confidence: aiReviewQueue.confidence, createdAt: aiReviewQueue.createdAt })
    .from(aiReviewQueue)
    .where(and(eq(aiReviewQueue.companyId, companyId), eq(aiReviewQueue.status, "pending")))
    .orderBy(sql`${aiReviewQueue.createdAt} desc`)
    .limit(SOURCE_LIMIT);
  for (const pr of props) {
    const b = base(pr.projectId);
    if (!b) continue;
    out.push({
      ...b,
      kind: "agent_proposal",
      severity: "low",
      title: `Agent proposal awaiting review: ${pr.summary}`,
      detail: `${pr.targetType.replace(/_/g, " ")}${pr.confidence !== null ? ` · confidence ${Math.round(pr.confidence * 100)}%` : ""} · proposed ${isoDate(new Date(pr.createdAt))}`,
      dueAt: null,
      href: pr.projectId ? `/projects/${pr.projectId}/ai` : "/agents",
      sourceType: "ai_review_item",
      sourceId: pr.id,
    });
  }

  /* --- insurance certificates expiring --- */
  const certs = await db
    .select({ id: insuranceCertificates.id, projectId: insuranceCertificates.projectId, subjectName: insuranceCertificates.subjectName, policyType: insuranceCertificates.policyType, validTo: insuranceCertificates.validTo })
    .from(insuranceCertificates)
    .where(and(eq(insuranceCertificates.companyId, companyId), eq(insuranceCertificates.status, "active"), lte(insuranceCertificates.validTo, in30), gte(insuranceCertificates.validTo, isoDate(plusDays(now, -30)))))
    .orderBy(asc(insuranceCertificates.validTo))
    .limit(SOURCE_LIMIT);
  for (const c of certs) {
    const b = base(c.projectId);
    if (!b) continue;
    const dueAt = dateToIso(c.validTo);
    out.push({
      ...b,
      kind: "insurance_expiry",
      severity: severityForDeadline(dueAt, now, "medium"),
      title: `${c.policyType} certificate for ${c.subjectName} ${daysUntil(dueAt, now)! < 0 ? "expired" : "expires"}`,
      detail: `Valid to ${c.validTo} — ${overdueText(daysUntil(dueAt, now))}`,
      dueAt,
      href: c.projectId ? `/projects/${c.projectId}/insurance` : "/directory",
      sourceType: "insurance_certificate",
      sourceId: c.id,
    });
  }

  /* --- covenant breaches (latest reading) --- */
  const covRows = await db
    .select({ id: covenants.id, projectId: covenants.projectId, name: covenants.name })
    .from(covenants)
    .where(eq(covenants.companyId, companyId))
    .limit(SOURCE_LIMIT);
  if (covRows.length > 0) {
    const readings = await db
      .select({ covenantId: covenantReadings.covenantId, compliant: covenantReadings.compliant, headroom: covenantReadings.headroom, readingDate: covenantReadings.readingDate })
      .from(covenantReadings)
      .where(and(eq(covenantReadings.companyId, companyId), inArray(covenantReadings.covenantId, covRows.map((c) => c.id))))
      .orderBy(sql`${covenantReadings.readingDate} desc`, sql`${covenantReadings.createdAt} desc`)
      .limit(5000);
    const latest = new Map<string, (typeof readings)[number]>();
    for (const rd of readings) if (!latest.has(rd.covenantId)) latest.set(rd.covenantId, rd);
    for (const c of covRows) {
      const rd = latest.get(c.id);
      if (!rd || rd.compliant !== 0) continue;
      const b = base(c.projectId);
      if (!b) continue;
      out.push({
        ...b,
        kind: "covenant_breach",
        severity: "high",
        title: `Covenant breached: ${c.name}`,
        detail: `Latest reading on ${rd.readingDate} is non-compliant (headroom ${rd.headroom})`,
        dueAt: null,
        href: `/projects/${c.projectId}/finance`,
        sourceType: "covenant",
        sourceId: c.id,
      });
    }
  }

  /* --- change events past due --- */
  const ces = await db
    .select({ id: changeEvents.id, projectId: changeEvents.projectId, reference: changeEvents.reference, title: changeEvents.title, latestCost: changeEvents.latestCost, dueDate: changeEvents.dueDate, status: changeEvents.status })
    .from(changeEvents)
    .where(and(eq(changeEvents.companyId, companyId), inArray(changeEvents.status, ["open", "pending"]), isNotNull(changeEvents.dueDate), lt(changeEvents.dueDate, today)))
    .orderBy(asc(changeEvents.dueDate))
    .limit(SOURCE_LIMIT);
  for (const c of ces) {
    const b = base(c.projectId);
    if (!b) continue;
    const dueAt = dateToIso(c.dueDate);
    out.push({
      ...b,
      kind: "change_exposure",
      severity: "medium",
      title: `Change event ${c.reference} past due: ${c.title}`,
      detail: `${overdueText(daysUntil(dueAt, now))} · ${c.status} · latest cost ${c.latestCost.toLocaleString()} ${b.currency ?? ""}`.trim(),
      dueAt,
      href: `/projects/${c.projectId}/changes`,
      sourceType: "change_event",
      sourceId: c.id,
      money: c.latestCost,
      currency: b.currency,
    });
  }

  return out;
}
