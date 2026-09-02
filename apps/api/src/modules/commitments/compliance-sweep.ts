import type { FastifyPluginAsync } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  bonds,
  commitmentPayments,
  complianceSweepState,
  insuranceCertificates,
  projectMemberships,
  projects,
  vendors,
} from "@constructos/db";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import type { Db } from "../../lib/db.js";
import { forEachCompany } from "../../lib/scheduler.js";
import { pushNotifications } from "../notifications/service.js";
import { assessProjectCommitments, type CommitmentComplianceEntry } from "./compliance.js";
import { round2, todayIso } from "./shared.js";

/**
 * PROACTIVE COMPLIANCE EXPIRY ALERTING (spec #530–532).
 *
 * The compliance engine answers "can this vendor be paid today?" on every
 * payment. What it did not do, until this file, was tell anybody BEFORE the
 * answer became no. A certificate that expires on the 14th is a phone call on
 * the 1st and a stopped payment on the 15th; the difference is a sweep.
 *
 * Once a day (scheduler job `commitments.compliance-sweep`) every active
 * project's commitments are assessed in one pass and DIFFED against what the
 * previous sweep saw (`compliance_sweep_state`), so the job notifies on
 * change — a commitment newly blocked, a certificate crossing the 30/14/7-day
 * line, a payment sitting on hold for more than seven days — and never
 * repeats itself every morning. Every notice is recorded on the state row and
 * in the ledger as a system act.
 *
 * Read side: `GET /projects/:id/commitments/compliance/upcoming?days=30` lists
 * the certificates and bonds that run out inside the window on commitments
 * that still have money to pay, with the vendor-facing renewal request text.
 */

const EXPIRY_LINES = [30, 14, 7] as const;
const HOLD_NOTICE_AFTER_DAYS = 7;

export interface UpcomingExpiry {
  commitmentId: string;
  reference: string;
  title: string;
  vendorId: string | null;
  vendorName: string | null;
  vendorEmail: string | null;
  currency: string;
  /** revised sum less paid — money the vendor still has coming */
  unpaidBalance: number;
  subjectType: "certificate" | "bond";
  subjectId: string;
  /** policy type or bond type */
  coverage: string;
  expiresOn: string;
  daysUntilExpiry: number;
  /** the line this sits on: 30, 14 or 7 */
  line: number | null;
  /** a plain-language renewal request the project can send the vendor */
  renewalRequest: string;
}

const daysBetween = (fromIso: string, toIso: string): number =>
  Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);

function lineFor(days: number): number | null {
  for (const line of EXPIRY_LINES) if (days <= line) return line;
  return null;
}

function renewalText(vendorName: string | null, coverage: string, expiresOn: string, reference: string): string {
  return (
    `Dear ${vendorName ?? "supplier"}, our records show that your ${coverage} cover on file for ` +
    `${reference} expires on ${expiresOn}. Please send a renewed certificate before that date; ` +
    "payments against the commitment are stopped while cover is not evidenced."
  );
}

/**
 * Certificates and bonds expiring within `days` on the project's commitments
 * that still carry an unpaid balance. Pure read; the sweep and the endpoint
 * both use it.
 */
export async function upcomingExpiries(
  db: Db,
  companyId: string,
  projectId: string,
  days: number,
  asOf: string = todayIso(),
): Promise<{ items: UpcomingExpiry[]; entries: CommitmentComplianceEntry[] }> {
  const report = await assessProjectCommitments(db, companyId, projectId, asOf);
  const live = report.entries.filter(
    (e) => (e.status === "approved" || e.status === "complete") && e.vendorId,
  );
  const vendorIds = [...new Set(live.map((e) => e.vendorId!))];
  if (vendorIds.length === 0) return { items: [], entries: report.entries };
  const [certRows, bondRows, vendorRows, paid] = await Promise.all([
    db
      .select({
        id: insuranceCertificates.id,
        vendorId: insuranceCertificates.vendorId,
        policyType: insuranceCertificates.policyType,
        validTo: insuranceCertificates.validTo,
        status: insuranceCertificates.status,
      })
      .from(insuranceCertificates)
      .where(
        and(
          eq(insuranceCertificates.companyId, companyId),
          inArray(insuranceCertificates.vendorId, vendorIds),
        ),
      ),
    db
      .select({
        id: bonds.id,
        vendorId: bonds.principalVendorId,
        bondType: bonds.bondType,
        expiryAt: bonds.expiryAt,
        status: bonds.status,
      })
      .from(bonds)
      .where(and(eq(bonds.companyId, companyId), inArray(bonds.principalVendorId, vendorIds))),
    db
      .select({ id: vendors.id, name: vendors.name, email: vendors.email })
      .from(vendors)
      .where(inArray(vendors.id, vendorIds)),
    db
      .select({
        commitmentId: commitmentPayments.commitmentId,
        status: commitmentPayments.status,
        amount: commitmentPayments.amount,
      })
      .from(commitmentPayments)
      .where(
        and(
          eq(commitmentPayments.companyId, companyId),
          eq(commitmentPayments.projectId, projectId),
          inArray(commitmentPayments.status, ["issued", "cleared"]),
        ),
      ),
  ]);
  const vendorById = new Map(vendorRows.map((v) => [v.id, v]));
  const paidBy = new Map<string, number>();
  for (const p of paid) paidBy.set(p.commitmentId, round2((paidBy.get(p.commitmentId) ?? 0) + p.amount));

  const items: UpcomingExpiry[] = [];
  for (const e of live) {
    const unpaid = round2(e.revisedCommitmentSum - (paidBy.get(e.commitmentId) ?? 0));
    if (unpaid <= 0.005) continue;
    const vendor = vendorById.get(e.vendorId!) ?? null;
    const push = (
      subjectType: "certificate" | "bond",
      subjectId: string,
      coverage: string,
      expiresOn: string,
    ) => {
      const until = daysBetween(asOf, expiresOn);
      if (until < 0 || until > days) return;
      items.push({
        commitmentId: e.commitmentId,
        reference: e.reference,
        title: e.title,
        vendorId: e.vendorId,
        vendorName: vendor?.name ?? e.vendorName,
        vendorEmail: vendor?.email ?? null,
        currency: e.currency,
        unpaidBalance: unpaid,
        subjectType,
        subjectId,
        coverage,
        expiresOn,
        daysUntilExpiry: until,
        line: lineFor(until),
        renewalRequest: renewalText(vendor?.name ?? e.vendorName, coverage, expiresOn, e.reference),
      });
    };
    for (const c of certRows) {
      if (c.vendorId !== e.vendorId || c.status === "void" || c.status === "superseded") continue;
      push("certificate", c.id, c.policyType, c.validTo);
    }
    for (const b of bondRows) {
      if (b.vendorId !== e.vendorId || !b.expiryAt || b.status === "released" || b.status === "void") continue;
      push("bond", b.id, b.bondType, b.expiryAt);
    }
  }
  items.sort((a, b) => a.daysUntilExpiry - b.daysUntilExpiry || b.unpaidBalance - a.unpaidBalance);
  return { items, entries: report.entries };
}

export interface SweepSummary {
  projects: number;
  commitments: number;
  newlyBlocked: number;
  expiryNotices: number;
  holdNotices: number;
}

/** Users to notify for a project: its members (the project team). */
async function projectRecipients(db: Db, companyId: string, projectId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: projectMemberships.userId })
    .from(projectMemberships)
    .where(and(eq(projectMemberships.companyId, companyId), eq(projectMemberships.projectId, projectId)));
  return [...new Set(rows.map((r) => r.userId))];
}

/**
 * One company's sweep. Idempotent by construction: every notice it would
 * send is keyed ("cert:<id>:30", a status transition, a hold date) and
 * recorded on the state row, so the next run skips what has been said.
 */
export async function sweepCompanyCompliance(
  db: Db,
  companyId: string,
  now: Date = new Date(),
): Promise<SweepSummary> {
  const asOf = now.toISOString().slice(0, 10);
  const projectRows = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(eq(projects.companyId, companyId));
  const summary: SweepSummary = { projects: 0, commitments: 0, newlyBlocked: 0, expiryNotices: 0, holdNotices: 0 };

  for (const project of projectRows) {
    summary.projects += 1;
    const { items, entries } = await upcomingExpiries(db, companyId, project.id, 30, asOf);
    if (entries.length === 0) continue;
    const recipients = await projectRecipients(db, companyId, project.id);
    const stateRows = await db
      .select()
      .from(complianceSweepState)
      .where(eq(complianceSweepState.projectId, project.id));
    const stateBy = new Map(stateRows.map((s) => [s.commitmentId, s]));
    const held = await db
      .select({
        id: commitmentPayments.id,
        commitmentId: commitmentPayments.commitmentId,
        reference: commitmentPayments.reference,
        amount: commitmentPayments.amount,
        currency: commitmentPayments.currency,
        updatedAt: commitmentPayments.updatedAt,
      })
      .from(commitmentPayments)
      .where(
        and(
          eq(commitmentPayments.companyId, companyId),
          eq(commitmentPayments.projectId, project.id),
          eq(commitmentPayments.status, "on_hold"),
        ),
      );
    const heldBy = new Map<string, typeof held>();
    for (const h of held) {
      const list = heldBy.get(h.commitmentId) ?? [];
      list.push(h);
      heldBy.set(h.commitmentId, list);
    }
    const expiriesBy = new Map<string, UpcomingExpiry[]>();
    for (const it of items) {
      const list = expiriesBy.get(it.commitmentId) ?? [];
      list.push(it);
      expiriesBy.set(it.commitmentId, list);
    }

    for (const entry of entries) {
      if (entry.status === "void" || entry.status === "terminated") continue;
      summary.commitments += 1;
      const prior = stateBy.get(entry.commitmentId);
      const status = entry.compliance.status;
      const codes = entry.compliance.findings.map((f) => f.code).sort();
      const notices: Array<{ title: string; body: string; kind: "compliance" | "overdue" }> = [];
      const sentNotices = new Set(prior?.lastExpiryNotices ?? []);
      let lastHoldNoticeAt = prior?.lastHoldNoticeAt ?? null;

      /* newly blocked: the status crossed into "blocked" since the last sweep */
      if (status === "blocked" && prior?.lastStatus !== "blocked") {
        summary.newlyBlocked += 1;
        notices.push({
          kind: "compliance",
          title: `${entry.reference} is now payment-blocked`,
          body:
            `${entry.vendorName ?? "The vendor"} on ${entry.reference} (${entry.title}) can no longer be paid: ` +
            entry.compliance.blocking.map((f) => f.message).join(" "),
        });
      }
      /* expiry lines crossed */
      for (const ex of expiriesBy.get(entry.commitmentId) ?? []) {
        if (ex.line === null) continue;
        const key = `${ex.subjectType}:${ex.subjectId}:${ex.line}`;
        if (sentNotices.has(key)) continue;
        sentNotices.add(key);
        summary.expiryNotices += 1;
        notices.push({
          kind: "compliance",
          title: `${ex.coverage} on ${entry.reference} expires in ${ex.daysUntilExpiry} day(s)`,
          body:
            `${ex.vendorName ?? "The vendor"}'s ${ex.coverage} ${ex.subjectType} runs out on ${ex.expiresOn}; ` +
            `${ex.unpaidBalance} ${ex.currency} remains unpaid on ${entry.reference}. ` +
            `Renewal request: ${ex.renewalRequest}`,
        });
      }
      /* payments on hold for too long */
      const stale = (heldBy.get(entry.commitmentId) ?? []).filter(
        (h) => daysBetween(h.updatedAt.slice(0, 10), asOf) >= HOLD_NOTICE_AFTER_DAYS,
      );
      if (stale.length > 0) {
        const lastNoticeDaysAgo = lastHoldNoticeAt ? daysBetween(lastHoldNoticeAt.slice(0, 10), asOf) : null;
        if (lastNoticeDaysAgo === null || lastNoticeDaysAgo >= HOLD_NOTICE_AFTER_DAYS) {
          summary.holdNotices += 1;
          lastHoldNoticeAt = now.toISOString();
          notices.push({
            kind: "overdue",
            title: `${stale.length} payment(s) on ${entry.reference} have sat on hold for ${HOLD_NOTICE_AFTER_DAYS}+ days`,
            body: stale.map((h) => `${h.reference}: ${h.amount} ${h.currency}`).join("; "),
          });
        }
      }

      if (notices.length > 0) {
        await pushNotifications(
          db,
          recipients.flatMap((userId) =>
            notices.map((n) => ({
              companyId,
              userId,
              projectId: project.id,
              kind: n.kind,
              title: n.title,
              body: n.body,
              recordType: "commitment",
              recordId: entry.commitmentId,
            })),
          ),
        );
        await appendLedger(db, {
          companyId,
          actorId: null,
          action: "update",
          objectType: "commitment",
          objectId: entry.commitmentId,
          projectId: project.id,
          payload: { complianceSweep: true, status, notices: notices.map((n) => n.title) },
        });
      }

      const values = {
        lastStatus: status,
        lastFindingCodes: codes,
        lastExpiryNotices: [...sentNotices],
        lastHoldNoticeAt,
        sweptAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
      if (prior) {
        await db.update(complianceSweepState).set(values).where(eq(complianceSweepState.id, prior.id));
      } else {
        await db.insert(complianceSweepState).values({
          id: newId("csw"),
          companyId,
          projectId: project.id,
          commitmentId: entry.commitmentId,
          ...values,
        });
      }
    }
  }
  return summary;
}

export const complianceSweepRoutes: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("commitments", "read")];

  app.scheduler.register({
    name: "commitments.compliance-sweep",
    description:
      "Diff every commitment's insurance/bond position against the last sweep; notify on newly " +
      "blocked commitments, certificates crossing the 30/14/7-day line and payments held 7+ days",
    everyMs: 24 * 60 * 60_000,
    runOnBoot: true,
    run: async ({ db, now }) => {
      const totals: SweepSummary = { projects: 0, commitments: 0, newlyBlocked: 0, expiryNotices: 0, holdNotices: 0 };
      const result = await forEachCompany(db, async (companyId) => {
        const s = await sweepCompanyCompliance(db, companyId, now);
        totals.projects += s.projects;
        totals.commitments += s.commitments;
        totals.newlyBlocked += s.newlyBlocked;
        totals.expiryNotices += s.expiryNotices;
        totals.holdNotices += s.holdNotices;
      });
      return { ...totals, companies: result.companies, failed: result.failed };
    },
  });

  app.get(
    "/projects/:projectId/commitments/compliance/upcoming",
    { preHandler: readGate },
    async (req) => {
      const q = z
        .object({ days: z.coerce.number().int().min(1).max(365).default(30) })
        .parse(req.query ?? {});
      const asOf = todayIso();
      const { items } = await upcomingExpiries(app.db, req.companyId!, req.projectId!, q.days, asOf);
      const state = await app.db
        .select({ commitmentId: complianceSweepState.commitmentId, sweptAt: complianceSweepState.sweptAt })
        .from(complianceSweepState)
        .where(eq(complianceSweepState.projectId, req.projectId!));
      const lastSweptAt = state.map((s) => s.sweptAt).sort().at(-1) ?? null;
      return {
        projectId: req.projectId!,
        asOf,
        windowDays: q.days,
        items,
        byLine: {
          within7: items.filter((i) => i.daysUntilExpiry <= 7).length,
          within14: items.filter((i) => i.daysUntilExpiry <= 14).length,
          within30: items.filter((i) => i.daysUntilExpiry <= 30).length,
        },
        lastSweptAt,
        note:
          lastSweptAt === null
            ? "The daily compliance sweep has not run for this project yet; this list is computed live."
            : null,
      };
    },
  );
};
