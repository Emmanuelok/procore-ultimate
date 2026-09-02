import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  bonds,
  contractComplianceChecks,
  contractObligationLinks,
  contracts,
  insurancePolicies,
  obligations,
} from "@constructos/db";
import { CONTRACT_COMPLIANCE_KINDS, type ContractForm } from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { appendLedger } from "../../lib/ledger.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { pageQuerySchema } from "../../lib/pagination.js";
import { isoDateSchema, todayISO } from "../field/dates.js";
import {
  complianceTemplatesForForm,
  evaluateCompliance,
  type ComplianceEvidence,
} from "./compliance.js";

const checkCreateSchema = z.object({
  kind: z.enum(CONTRACT_COMPLIANCE_KINDS),
  clauseRef: z.string().max(60).nullable().optional(),
  requirement: z.string().min(1).max(4000),
  requiredAmount: z.number().nonnegative().nullable().optional(),
  currency: z.string().min(3).max(8).optional(),
  requiredUntil: isoDateSchema.nullable().optional(),
});

const checkLinkSchema = z.object({
  evidenceType: z.enum(["insurance_policy", "bond", "none"]),
  evidenceId: z.string().max(60).nullable().optional(),
});

/**
 * Insurance, bond and guarantee clause compliance (spec Vol II Domain C
 * #251-253).
 *
 * Seeding a contract writes the standard form's own requirement set; each
 * requirement can then be linked to the policy or bond that answers it, and
 * re-evaluated on demand or by the scheduled sweep. Every verdict carries its
 * reason, and "no evidence" is `unknown`, never a silent pass.
 */
export const complianceRoutes: FastifyPluginAsync = async (app) => {
  const readGate = [app.authenticate, app.requireCompany, app.requireTool("contracts", "read")];
  const standardGate = [
    app.authenticate,
    app.requireCompany,
    app.requireTool("contracts", "standard"),
  ];

  async function fetchContract(contractId: string, companyId: string, projectId: string) {
    const rows = await app.db
      .select()
      .from(contracts)
      .where(
        and(
          eq(contracts.id, contractId),
          eq(contracts.companyId, companyId),
          eq(contracts.projectId, projectId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw notFound("Contract not found");
    return rows[0];
  }

  /** Load the evidence a check points at, whatever kind it is. */
  async function loadEvidence(
    companyId: string,
    evidenceType: string | null,
    evidenceId: string | null,
  ): Promise<ComplianceEvidence | null> {
    if (!evidenceType || !evidenceId) return null;
    if (evidenceType === "insurance_policy") {
      const rows = await app.db
        .select()
        .from(insurancePolicies)
        .where(
          and(eq(insurancePolicies.id, evidenceId), eq(insurancePolicies.companyId, companyId)),
        )
        .limit(1);
      const p = rows[0];
      if (!p) return null;
      return {
        evidenceType,
        evidenceId,
        amount: p.limitOfIndemnity,
        currency: p.currency,
        expiry: p.periodEnd,
        status: p.status,
        label: `Policy ${p.policyNumber} (${p.policyType})`,
      };
    }
    if (evidenceType === "bond") {
      const rows = await app.db
        .select()
        .from(bonds)
        .where(and(eq(bonds.id, evidenceId), eq(bonds.companyId, companyId)))
        .limit(1);
      const b = rows[0];
      if (!b) return null;
      return {
        evidenceType,
        evidenceId,
        amount: b.amount,
        currency: b.currency,
        expiry: b.expiryAt,
        status: b.releasedAt ? "released" : b.status,
        label: `Bond ${b.bondNumber ?? b.number} (${b.bondType})`,
      };
    }
    return null;
  }

  /** Re-evaluate one contract's checks and persist the verdicts. */
  async function evaluateContract(
    companyId: string,
    projectId: string,
    contractId: string,
    actorId: string,
  ): Promise<{ evaluated: number; byStatus: Record<string, number> }> {
    const checks = await app.db
      .select()
      .from(contractComplianceChecks)
      .where(
        and(
          eq(contractComplianceChecks.companyId, companyId),
          eq(contractComplianceChecks.contractId, contractId),
        ),
      );
    const today = todayISO();
    const byStatus: Record<string, number> = {};
    const now = new Date().toISOString();
    for (const check of checks) {
      const evidence = await loadEvidence(companyId, check.evidenceType, check.evidenceId);
      const verdict = evaluateCompliance({
        requirement: check.requirement,
        kind: check.kind as never,
        requiredAmount: check.requiredAmount,
        currency: check.currency,
        requiredUntil: check.requiredUntil,
        evidence,
        today,
      });
      byStatus[verdict.status] = (byStatus[verdict.status] ?? 0) + 1;
      const changed = check.status !== verdict.status;
      await app.db
        .update(contractComplianceChecks)
        .set({
          status: verdict.status,
          reason: verdict.reason,
          evidenceExpiry: evidence?.expiry ?? null,
          evidenceAmount: evidence?.amount ?? null,
          lastCheckedAt: now,
          updatedAt: now,
        })
        .where(eq(contractComplianceChecks.id, check.id));
      if (changed) {
        await appendLedger(app.db, {
          companyId,
          actorId,
          action: "state_change",
          objectType: "contract_compliance_check",
          objectId: check.id,
          projectId,
          payload: { from: check.status, to: verdict.status, reason: verdict.reason },
        });
      }
      // A non-compliant requirement is a live obligation, not a status badge.
      if (check.obligationId) {
        await app.db
          .update(obligations)
          .set({ status: verdict.status === "compliant" ? "satisfied" : "open" })
          .where(eq(obligations.id, check.obligationId));
      }
    }
    return { evaluated: checks.length, byStatus };
  }

  app.get(
    "/projects/:projectId/contracts/:contractId/compliance",
    { preHandler: readGate },
    async (req) => {
      const { contractId } = req.params as { contractId: string };
      const q = pageQuerySchema.parse(req.query);
      const contract = await fetchContract(contractId, req.companyId!, req.projectId!);
      const [totalRow] = await app.db
        .select({ n: count() })
        .from(contractComplianceChecks)
        .where(
          and(
            eq(contractComplianceChecks.companyId, req.companyId!),
            eq(contractComplianceChecks.contractId, contractId),
          ),
        );
      const items = await app.db
        .select()
        .from(contractComplianceChecks)
        .where(
          and(
            eq(contractComplianceChecks.companyId, req.companyId!),
            eq(contractComplianceChecks.contractId, contractId),
          ),
        )
        .orderBy(asc(contractComplianceChecks.kind), asc(contractComplianceChecks.clauseRef))
        .limit(q.pageSize);
      const byStatus: Record<string, number> = {};
      for (const c of items) byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
      return {
        items,
        total: Number(totalRow?.n ?? 0),
        page: q.page,
        pageSize: q.pageSize,
        byStatus,
        available: complianceTemplatesForForm(contract.form as ContractForm).length,
      };
    },
  );

  /**
   * Seed the requirement set the contract's standard form imposes. Idempotent:
   * a requirement already recorded for the same clause is left alone.
   */
  app.post(
    "/projects/:projectId/contracts/:contractId/compliance/seed",
    { preHandler: standardGate },
    async (req, reply) => {
      const { contractId } = req.params as { contractId: string };
      const contract = await fetchContract(contractId, req.companyId!, req.projectId!);
      const templates = complianceTemplatesForForm(contract.form as ContractForm);
      if (templates.length === 0) {
        throw badRequest(
          `The ${contract.form} library carries no insurance or bond requirement set; add requirements individually.`,
        );
      }
      const existing = await app.db
        .select({ clauseRef: contractComplianceChecks.clauseRef })
        .from(contractComplianceChecks)
        .where(eq(contractComplianceChecks.contractId, contractId));
      const seen = new Set(existing.map((e) => e.clauseRef));
      const requiredUntilFor = (until: string | undefined): string | null => {
        if (until === "completion") return contract.completionDate;
        if (until === "defects_end") {
          if (!contract.completionDate || contract.defectsPeriodMonths == null) return null;
          const d = new Date(`${contract.completionDate}T00:00:00Z`);
          d.setUTCMonth(d.getUTCMonth() + contract.defectsPeriodMonths);
          return d.toISOString().slice(0, 10);
        }
        return null;
      };

      let created = 0;
      for (const t of templates) {
        if (seen.has(t.clauseRef)) continue;
        const id = newId("ccc");
        const requiredAmount =
          t.percentOfContractSum != null && contract.contractSum != null
            ? Math.round(contract.contractSum * (t.percentOfContractSum / 100) * 100) / 100
            : null;
        const obligationId = newId("obl");
        await app.db.transaction(async (tx) => {
          await tx.insert(obligations).values({
            id: obligationId,
            companyId: req.companyId!,
            projectId: req.projectId!,
            sourceClause: `${contract.form} ${t.clauseRef}`,
            trigger: t.requirement,
            deadline: null,
            evidenceRequirement:
              t.kind === "bond" ? "Executed bond or guarantee" : "Certificate of insurance",
            status: "open",
            createdBy: req.user!.id,
          });
          await tx.insert(contractObligationLinks).values({
            id: newId("col"),
            companyId: req.companyId!,
            projectId: req.projectId!,
            contractId,
            contractEventId: null,
            obligationId,
            kind: "compliance",
            clauseRef: t.clauseRef,
          });
          await tx.insert(contractComplianceChecks).values({
            id,
            companyId: req.companyId!,
            projectId: req.projectId!,
            contractId,
            kind: t.kind,
            clauseRef: t.clauseRef,
            requirement: t.requirement,
            requiredAmount,
            currency: contract.currency,
            requiredUntil: requiredUntilFor(t.until),
            status: "unknown",
            reason: "No evidence has been linked to this requirement yet.",
            obligationId,
            createdBy: req.user!.id,
          });
        });
        created += 1;
      }
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "contract",
        objectId: contractId,
        projectId: req.projectId!,
        payload: { seededComplianceChecks: created, form: contract.form },
      });
      return reply.status(201).send({ created, skipped: templates.length - created });
    },
  );

  app.post(
    "/projects/:projectId/contracts/:contractId/compliance",
    { preHandler: standardGate },
    async (req, reply) => {
      const { contractId } = req.params as { contractId: string };
      const body = checkCreateSchema.parse(req.body);
      const contract = await fetchContract(contractId, req.companyId!, req.projectId!);
      const id = newId("ccc");
      await app.db.insert(contractComplianceChecks).values({
        id,
        companyId: req.companyId!,
        projectId: req.projectId!,
        contractId,
        kind: body.kind,
        clauseRef: body.clauseRef ?? null,
        requirement: body.requirement,
        requiredAmount: body.requiredAmount ?? null,
        currency: body.currency ?? contract.currency,
        requiredUntil: body.requiredUntil ?? null,
        status: "unknown",
        reason: "No evidence has been linked to this requirement yet.",
        createdBy: req.user!.id,
      });
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "create",
        objectType: "contract_compliance_check",
        objectId: id,
        projectId: req.projectId!,
        payload: { kind: body.kind, clauseRef: body.clauseRef ?? null },
      });
      const created = await app.db
        .select()
        .from(contractComplianceChecks)
        .where(eq(contractComplianceChecks.id, id))
        .limit(1);
      return reply.status(201).send(created[0]);
    },
  );

  app.post(
    "/projects/:projectId/contracts/:contractId/compliance/:checkId/evidence",
    { preHandler: standardGate },
    async (req) => {
      const { contractId, checkId } = req.params as { contractId: string; checkId: string };
      const body = checkLinkSchema.parse(req.body);
      await fetchContract(contractId, req.companyId!, req.projectId!);
      const rows = await app.db
        .select()
        .from(contractComplianceChecks)
        .where(
          and(
            eq(contractComplianceChecks.id, checkId),
            eq(contractComplianceChecks.contractId, contractId),
            eq(contractComplianceChecks.companyId, req.companyId!),
          ),
        )
        .limit(1);
      const check = rows[0];
      if (!check) throw notFound("Compliance check not found");

      if (body.evidenceType === "none") {
        await app.db
          .update(contractComplianceChecks)
          .set({
            evidenceType: null,
            evidenceId: null,
            evidenceAmount: null,
            evidenceExpiry: null,
            status: "unknown",
            reason: "The evidence link was removed.",
            updatedAt: new Date().toISOString(),
          })
          .where(eq(contractComplianceChecks.id, checkId));
      } else {
        if (!body.evidenceId) throw badRequest("evidenceId is required");
        const evidence = await loadEvidence(req.companyId!, body.evidenceType, body.evidenceId);
        if (!evidence) {
          throw badRequest(`No ${body.evidenceType} with that id exists in this company`);
        }
        const verdict = evaluateCompliance({
          requirement: check.requirement,
          kind: check.kind as never,
          requiredAmount: check.requiredAmount,
          currency: check.currency,
          requiredUntil: check.requiredUntil,
          evidence,
          today: todayISO(),
        });
        await app.db
          .update(contractComplianceChecks)
          .set({
            evidenceType: body.evidenceType,
            evidenceId: body.evidenceId,
            evidenceAmount: evidence.amount,
            evidenceExpiry: evidence.expiry,
            status: verdict.status,
            reason: verdict.reason,
            lastCheckedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          })
          .where(eq(contractComplianceChecks.id, checkId));
        if (check.obligationId) {
          await app.db
            .update(obligations)
            .set({ status: verdict.status === "compliant" ? "satisfied" : "open" })
            .where(eq(obligations.id, check.obligationId));
        }
      }
      await appendLedger(app.db, {
        companyId: req.companyId!,
        actorId: req.user!.id,
        action: "update",
        objectType: "contract_compliance_check",
        objectId: checkId,
        projectId: req.projectId!,
        payload: { evidenceType: body.evidenceType, evidenceId: body.evidenceId ?? null },
      });
      const updated = await app.db
        .select()
        .from(contractComplianceChecks)
        .where(eq(contractComplianceChecks.id, checkId))
        .limit(1);
      return updated[0];
    },
  );

  app.post(
    "/projects/:projectId/contracts/:contractId/compliance/evaluate",
    { preHandler: standardGate },
    async (req) => {
      const { contractId } = req.params as { contractId: string };
      await fetchContract(contractId, req.companyId!, req.projectId!);
      return evaluateContract(req.companyId!, req.projectId!, contractId, req.user!.id);
    },
  );

  /** Project-wide compliance position, for the contracts workspace header. */
  app.get("/projects/:projectId/contract-compliance", { preHandler: readGate }, async (req) => {
    const rows = await app.db
      .select()
      .from(contractComplianceChecks)
      .where(
        and(
          eq(contractComplianceChecks.companyId, req.companyId!),
          eq(contractComplianceChecks.projectId, req.projectId!),
        ),
      );
    const byStatus: Record<string, number> = {};
    for (const c of rows) byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
    const contractIds = [...new Set(rows.map((r) => r.contractId))];
    const names =
      contractIds.length === 0
        ? []
        : await app.db
            .select({ id: contracts.id, name: contracts.name })
            .from(contracts)
            .where(inArray(contracts.id, contractIds));
    const nameById = new Map(names.map((n) => [n.id, n.name]));
    return {
      items: rows.map((r) => ({ ...r, contractName: nameById.get(r.contractId) ?? null })),
      total: rows.length,
      byStatus,
    };
  });
};
