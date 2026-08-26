import type { FastifyPluginAsync } from "fastify";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  changeOrderPackages,
  changeOrderRequests,
  commitmentChanges,
  commitmentSovLines,
  potentialChangeOrders,
  primeContractChanges,
  primeContractSovLines,
  primeContracts,
} from "@constructos/db";
import {
  CHANGE_ORDER_PACKAGE_KINDS,
  CHANGE_ORDER_STATUSES,
  type ChangeOrderPackageKind,
} from "@constructos/shared";
import { newId } from "../../lib/ids.js";
import { nextRecordNumber } from "../../lib/numbering.js";
import { badRequest, conflict } from "../../lib/errors.js";
import { pageOffset, pageQuerySchema, paginate } from "../../lib/pagination.js";
import { checkIdentity, round2 } from "./arithmetic.js";
import { executeCommitmentPackage, executePrimePackage } from "./execute.js";
import { recomputeEventRollup } from "./events.js";
import {
  actorOf,
  assertSegregation,
  assertTransition,
  changeGates,
  companyOf,
  detailSchema,
  fetchPackage,
  idSchema,
  isoDateSchema,
  ledgerChange,
  loadLinesForParents,
  nowIso,
  pad3,
  projectOf,
} from "./shared.js";

const packageCreateSchema = z.object({
  kind: z.enum(CHANGE_ORDER_PACKAGE_KINDS),
  title: z.string().min(1).max(300),
  description: z.string().max(20000).nullable().optional(),
  primeContractId: idSchema.nullable().optional(),
  commitmentId: idSchema.nullable().optional(),
  changeEventId: idSchema.nullable().optional(),
  memberIds: z.array(idSchema).min(1).max(200),
  dueDate: isoDateSchema.nullable().optional(),
  signedDate: isoDateSchema.nullable().optional(),
  documentIds: z.array(idSchema).max(200).optional(),
  detail: detailSchema.optional(),
});

const packagePatchSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  description: z.string().max(20000).nullable().optional(),
  dueDate: isoDateSchema.nullable().optional(),
  signedDate: isoDateSchema.nullable().optional(),
  documentIds: z.array(idSchema).max(200).optional(),
  detail: detailSchema.optional(),
});

const packageListQuery = pageQuerySchema.extend({
  kind: z.enum(CHANGE_ORDER_PACKAGE_KINDS).optional(),
  status: z.enum(CHANGE_ORDER_STATUSES).optional(),
  primeContractId: idSchema.optional(),
  commitmentId: idSchema.optional(),
});

const rejectSchema = z.object({ rejectionReason: z.string().min(1).max(8000) });

const executeSchema = z.object({
  signedDate: isoDateSchema.nullable().optional(),
  executedDate: isoDateSchema.nullable().optional(),
  /** the caller states the figure they believe they are executing */
  expectedAmount: z.number().finite().optional(),
});

export const packageRoutes: FastifyPluginAsync = async (app) => {
  const gates = changeGates(app);

  async function loadPrimeMembers(
    memberIds: readonly string[],
    companyId: string,
    projectId: string,
    packageId: string | null,
  ) {
    const rows = await app.db
      .select()
      .from(changeOrderRequests)
      .where(
        and(
          inArray(changeOrderRequests.id, [...memberIds]),
          eq(changeOrderRequests.companyId, companyId),
          eq(changeOrderRequests.projectId, projectId),
        ),
      )
      .orderBy(asc(changeOrderRequests.number));
    const found = new Set(rows.map((r) => r.id));
    const missing = memberIds.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw badRequest(
        `These change order requests are not on this project: ${missing.join(", ")}.`,
      );
    }
    const notApproved = rows.filter(
      (r) => r.status !== "approved" && r.status !== "partially_approved",
    );
    if (notApproved.length > 0) {
      throw conflict(
        `These change order requests have not been approved by the owner: ${notApproved
          .map((r) => `${r.reference} (${r.status})`)
          .join(", ")}. A package executes what the owner agreed, never what we asked for.`,
      );
    }
    const taken = rows.filter((r) => r.changeOrderPackageId && r.changeOrderPackageId !== packageId);
    if (taken.length > 0) {
      throw conflict(
        `These change order requests are already in another package: ${taken
          .map((r) => r.reference)
          .join(", ")}.`,
      );
    }
    const contractIds = [...new Set(rows.map((r) => r.primeContractId))];
    if (contractIds.length > 1) {
      throw badRequest(
        "These change order requests span more than one prime contract. One executed change order " +
          "amends one contract.",
      );
    }
    return rows;
  }

  async function loadCommitmentMembers(
    memberIds: readonly string[],
    companyId: string,
    projectId: string,
    packageId: string | null,
  ) {
    const rows = await app.db
      .select()
      .from(potentialChangeOrders)
      .where(
        and(
          inArray(potentialChangeOrders.id, [...memberIds]),
          eq(potentialChangeOrders.companyId, companyId),
          eq(potentialChangeOrders.projectId, projectId),
        ),
      )
      .orderBy(asc(potentialChangeOrders.number));
    const found = new Set(rows.map((r) => r.id));
    const missing = memberIds.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw badRequest(
        `These potential change orders are not on this project: ${missing.join(", ")}.`,
      );
    }
    const notApproved = rows.filter((r) => r.status !== "approved");
    if (notApproved.length > 0) {
      throw conflict(
        `These potential change orders are not approved: ${notApproved
          .map((r) => `${r.reference} (${r.status})`)
          .join(", ")}. Approve the cost position before committing to it.`,
      );
    }
    const taken = rows.filter(
      (r) => r.changeOrderPackageId && r.changeOrderPackageId !== packageId,
    );
    if (taken.length > 0) {
      throw conflict(
        `These potential change orders are already in another package: ${taken
          .map((r) => r.reference)
          .join(", ")}.`,
      );
    }
    const commitmentIds = [...new Set(rows.map((r) => r.commitmentId))];
    if (commitmentIds.length > 1 || commitmentIds[0] === null) {
      throw badRequest(
        "A commitment change order package must carry potential change orders against exactly one " +
          "commitment. Self-performed work has no subcontract to amend.",
      );
    }
    return rows;
  }

  app.post(
    "/projects/:projectId/change-order-packages",
    { preHandler: gates.standard },
    async (req, reply) => {
      const body = packageCreateSchema.parse(req.body);
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const actorId = actorOf(req);
      const kind: ChangeOrderPackageKind = body.kind;

      let amount = 0;
      let scheduleImpactDays = 0;
      let primeContractId: string | null = null;
      let commitmentId: string | null = null;
      let changeEventId = body.changeEventId ?? null;

      if (kind === "prime_contract") {
        const cors = await loadPrimeMembers(body.memberIds, companyId, projectId, null);
        primeContractId = cors[0]!.primeContractId;
        if (body.primeContractId && body.primeContractId !== primeContractId) {
          throw badRequest(
            "primeContractId does not match the contract these change order requests were made " +
              "against.",
          );
        }
        const [contract] = await app.db
          .select({ id: primeContracts.id })
          .from(primeContracts)
          .where(eq(primeContracts.id, primeContractId))
          .limit(1);
        if (!contract) throw badRequest("The prime contract behind these requests no longer exists.");
        // Currency needs no check here: every member request was validated
        // against ONE prime contract above, and a contract has one currency.
        // The package executes what was GRANTED, never what was asked.
        amount = round2(cors.reduce((s, c) => s + c.approvedAmount, 0));
        scheduleImpactDays = cors.reduce((s, c) => s + c.scheduleImpactApprovedDays, 0);
        changeEventId = changeEventId ?? cors.find((c) => c.changeEventId)?.changeEventId ?? null;
      } else {
        const pcos = await loadCommitmentMembers(body.memberIds, companyId, projectId, null);
        commitmentId = pcos[0]!.commitmentId!;
        if (body.commitmentId && body.commitmentId !== commitmentId) {
          throw badRequest(
            "commitmentId does not match the commitment these potential change orders price.",
          );
        }
        amount = round2(pcos.reduce((s, p) => s + p.amount, 0));
        scheduleImpactDays = pcos.reduce((max, p) => Math.max(max, p.scheduleImpactDays), 0);
        changeEventId = changeEventId ?? pcos.find((p) => p.changeEventId)?.changeEventId ?? null;
        primeContractId = pcos.find((p) => p.primeContractId)?.primeContractId ?? null;
      }

      if (amount === 0) {
        throw badRequest(
          "This package totals zero. A no-charge change is recorded on the PCO rather than " +
            "executed as a change order — executing a zero moves nothing and clutters the contract.",
        );
      }

      const number = await nextRecordNumber(
        app.db,
        projectId,
        `change_order_package:${kind}`,
      );
      const id = newId("cop");
      const reference = `${kind === "prime_contract" ? "PCCO" : "CCO"}-${pad3(number)}`;

      await app.db.transaction(async (tx) => {
        await tx.insert(changeOrderPackages).values({
          id,
          companyId,
          projectId,
          kind,
          number,
          reference,
          title: body.title,
          description: body.description ?? null,
          status: "draft",
          primeContractId,
          commitmentId,
          changeEventId,
          memberIds: [...body.memberIds],
          amount,
          scheduleImpactDays,
          dueDate: body.dueDate ?? null,
          signedDate: body.signedDate ?? null,
          documentIds: body.documentIds ?? [],
          detail: body.detail ?? {},
          createdBy: actorId,
        });
        if (kind === "prime_contract") {
          await tx
            .update(changeOrderRequests)
            .set({ changeOrderPackageId: id, updatedAt: nowIso() })
            .where(inArray(changeOrderRequests.id, [...body.memberIds]));
        } else {
          await tx
            .update(potentialChangeOrders)
            .set({ changeOrderPackageId: id, updatedAt: nowIso() })
            .where(inArray(potentialChangeOrders.id, [...body.memberIds]));
        }
      });

      await ledgerChange(app.db, req, "create", "change_order_package", id, {
        reference,
        kind,
        memberIds: body.memberIds,
        amount,
        scheduleImpactDays,
        primeContractId,
        commitmentId,
      });
      return reply.status(201).send(await fetchPackage(app.db, id, companyId, projectId));
    },
  );

  app.get("/projects/:projectId/change-order-packages", { preHandler: gates.read }, async (req) => {
    const q = packageListQuery.parse(req.query);
    const clauses = [
      eq(changeOrderPackages.companyId, companyOf(req)),
      eq(changeOrderPackages.projectId, projectOf(req)),
    ];
    if (q.kind) clauses.push(eq(changeOrderPackages.kind, q.kind));
    if (q.status) clauses.push(eq(changeOrderPackages.status, q.status));
    if (q.primeContractId) clauses.push(eq(changeOrderPackages.primeContractId, q.primeContractId));
    if (q.commitmentId) clauses.push(eq(changeOrderPackages.commitmentId, q.commitmentId));
    const where = and(...clauses);
    const [totalRow] = await app.db.select({ n: count() }).from(changeOrderPackages).where(where);
    const items = await app.db
      .select()
      .from(changeOrderPackages)
      .where(where)
      .orderBy(desc(changeOrderPackages.number))
      .limit(q.pageSize)
      .offset(pageOffset(q));
    return paginate(items, Number(totalRow?.n ?? 0), q);
  });

  app.get(
    "/projects/:projectId/change-order-packages/:pkgId",
    { preHandler: gates.read },
    async (req) => {
      const { pkgId } = req.params as { pkgId: string };
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const pkg = await fetchPackage(app.db, pkgId, companyId, projectId);

      const members =
        pkg.memberIds.length === 0
          ? []
          : pkg.kind === "prime_contract"
            ? await app.db
                .select()
                .from(changeOrderRequests)
                .where(inArray(changeOrderRequests.id, pkg.memberIds))
                .orderBy(asc(changeOrderRequests.number))
            : await app.db
                .select()
                .from(potentialChangeOrders)
                .where(inArray(potentialChangeOrders.id, pkg.memberIds))
                .orderBy(asc(potentialChangeOrders.number));

      const lines =
        pkg.kind === "prime_contract"
          ? await loadLinesForParents(app.db, "change_order_request", pkg.memberIds)
          : await loadLinesForParents(app.db, "potential_change_order", pkg.memberIds);

      const memberTotal = round2(
        pkg.kind === "prime_contract"
          ? (members as Array<{ approvedAmount: number }>).reduce((s, m) => s + m.approvedAmount, 0)
          : (members as Array<{ amount: number }>).reduce((s, m) => s + m.amount, 0),
      );

      const executedArtifacts: Record<string, unknown> = {};
      if (pkg.primeContractChangeId) {
        const [row] = await app.db
          .select()
          .from(primeContractChanges)
          .where(eq(primeContractChanges.id, pkg.primeContractChangeId))
          .limit(1);
        executedArtifacts["primeContractChange"] = row ?? null;
        const sov = await app.db
          .select()
          .from(primeContractSovLines)
          .where(eq(primeContractSovLines.changeOrderPackageId, pkg.id))
          .orderBy(asc(primeContractSovLines.sortOrder));
        executedArtifacts["appendedSovLines"] = sov;
        executedArtifacts["appendedSovTotal"] = round2(
          sov.reduce((s, l) => s + l.revisedScheduledValue, 0),
        );
      }
      if (pkg.commitmentChangeId) {
        const [row] = await app.db
          .select()
          .from(commitmentChanges)
          .where(eq(commitmentChanges.id, pkg.commitmentChangeId))
          .limit(1);
        executedArtifacts["commitmentChange"] = row ?? null;
        const sov = await app.db
          .select()
          .from(commitmentSovLines)
          .where(eq(commitmentSovLines.changeOrderPackageId, pkg.id))
          .orderBy(asc(commitmentSovLines.sortOrder));
        executedArtifacts["appendedSovLines"] = sov;
        executedArtifacts["appendedSovTotal"] = round2(
          sov.reduce((s, l) => s + l.revisedScheduledValue, 0),
        );
      }

      return {
        package: pkg,
        members,
        lines,
        identities: [
          checkIdentity("Σ member positions = package amount", memberTotal, pkg.amount),
          ...(executedArtifacts["appendedSovTotal"] !== undefined
            ? [
                checkIdentity(
                  "Σ appended SOV lines = package amount",
                  executedArtifacts["appendedSovTotal"] as number,
                  pkg.amount,
                ),
              ]
            : []),
        ],
        executed: executedArtifacts,
      };
    },
  );

  app.patch(
    "/projects/:projectId/change-order-packages/:pkgId",
    { preHandler: gates.standard },
    async (req) => {
      const { pkgId } = req.params as { pkgId: string };
      const body = packagePatchSchema.parse(req.body);
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const pkg = await fetchPackage(app.db, pkgId, companyId, projectId);
      assertTransition(pkg.status, ["draft", "revise_and_resubmit"], "change order package", "edit");
      const set: Record<string, unknown> = { updatedAt: nowIso() };
      for (const [key, value] of Object.entries(body)) {
        if (value !== undefined) set[key] = value;
      }
      await app.db.update(changeOrderPackages).set(set).where(eq(changeOrderPackages.id, pkgId));
      await ledgerChange(app.db, req, "update", "change_order_package", pkgId, {
        reference: pkg.reference,
        changed: Object.keys(body),
      });
      return fetchPackage(app.db, pkgId, companyId, projectId);
    },
  );

  app.post(
    "/projects/:projectId/change-order-packages/:pkgId/submit",
    { preHandler: gates.standard },
    async (req) => {
      const { pkgId } = req.params as { pkgId: string };
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const pkg = await fetchPackage(app.db, pkgId, companyId, projectId);
      assertTransition(
        pkg.status,
        ["draft", "revise_and_resubmit"],
        "change order package",
        "submit",
      );
      const now = nowIso();
      await app.db
        .update(changeOrderPackages)
        .set({
          status: "pending_in_house_review",
          submittedBy: actorOf(req),
          submittedAt: now,
          updatedAt: now,
        })
        .where(eq(changeOrderPackages.id, pkgId));
      await ledgerChange(app.db, req, "state_change", "change_order_package", pkgId, {
        reference: pkg.reference,
        from: pkg.status,
        to: "pending_in_house_review",
        amount: pkg.amount,
      });
      return fetchPackage(app.db, pkgId, companyId, projectId);
    },
  );

  app.post(
    "/projects/:projectId/change-order-packages/:pkgId/approve",
    { preHandler: gates.standard },
    async (req) => {
      const { pkgId } = req.params as { pkgId: string };
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const actorId = actorOf(req);
      const pkg = await fetchPackage(app.db, pkgId, companyId, projectId);
      assertTransition(
        pkg.status,
        ["pending_in_house_review", "pending_owner_approval"],
        "change order package",
        "approve",
      );
      assertSegregation(
        actorId,
        { createdBy: pkg.createdBy, submittedBy: pkg.submittedBy },
        "change order package",
      );
      const now = nowIso();
      await app.db
        .update(changeOrderPackages)
        .set({ status: "approved", approvedBy: actorId, approvedAt: now, updatedAt: now })
        .where(eq(changeOrderPackages.id, pkgId));
      await ledgerChange(app.db, req, "state_change", "change_order_package", pkgId, {
        reference: pkg.reference,
        from: pkg.status,
        to: "approved",
        amount: pkg.amount,
        submittedBy: pkg.submittedBy,
        approvedBy: actorId,
      });
      return fetchPackage(app.db, pkgId, companyId, projectId);
    },
  );

  app.post(
    "/projects/:projectId/change-order-packages/:pkgId/reject",
    { preHandler: gates.standard },
    async (req) => {
      const { pkgId } = req.params as { pkgId: string };
      const body = rejectSchema.parse(req.body);
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const actorId = actorOf(req);
      const pkg = await fetchPackage(app.db, pkgId, companyId, projectId);
      assertTransition(
        pkg.status,
        ["pending_in_house_review", "pending_owner_approval", "approved"],
        "change order package",
        "reject",
      );
      assertSegregation(
        actorId,
        { createdBy: pkg.createdBy, submittedBy: pkg.submittedBy },
        "change order package",
      );
      const now = nowIso();
      await app.db
        .update(changeOrderPackages)
        .set({
          status: "rejected",
          rejectedBy: actorId,
          rejectedAt: now,
          rejectionReason: body.rejectionReason,
          updatedAt: now,
        })
        .where(eq(changeOrderPackages.id, pkgId));
      await ledgerChange(app.db, req, "state_change", "change_order_package", pkgId, {
        reference: pkg.reference,
        from: pkg.status,
        to: "rejected",
        rejectionReason: body.rejectionReason,
      });
      return fetchPackage(app.db, pkgId, companyId, projectId);
    },
  );

  app.post(
    "/projects/:projectId/change-order-packages/:pkgId/void",
    { preHandler: gates.standard },
    async (req) => {
      const { pkgId } = req.params as { pkgId: string };
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const pkg = await fetchPackage(app.db, pkgId, companyId, projectId);
      if (pkg.status === "executed") {
        throw conflict(
          `${pkg.reference} has been executed: it is inside the contract sum and the budget. ` +
            "Reverse it with a further change order rather than deleting the history.",
        );
      }
      assertTransition(
        pkg.status,
        ["draft", "pending_in_house_review", "pending_owner_approval", "rejected", "revise_and_resubmit"],
        "change order package",
        "void",
      );
      await app.db.transaction(async (tx) => {
        await tx
          .update(changeOrderPackages)
          .set({ status: "void", updatedAt: nowIso() })
          .where(eq(changeOrderPackages.id, pkgId));
        if (pkg.memberIds.length > 0) {
          if (pkg.kind === "prime_contract") {
            await tx
              .update(changeOrderRequests)
              .set({ changeOrderPackageId: null, updatedAt: nowIso() })
              .where(inArray(changeOrderRequests.id, pkg.memberIds));
          } else {
            await tx
              .update(potentialChangeOrders)
              .set({ changeOrderPackageId: null, updatedAt: nowIso() })
              .where(inArray(potentialChangeOrders.id, pkg.memberIds));
          }
        }
      });
      await ledgerChange(app.db, req, "state_change", "change_order_package", pkgId, {
        reference: pkg.reference,
        from: pkg.status,
        to: "void",
        releasedMemberIds: pkg.memberIds,
      });
      return fetchPackage(app.db, pkgId, companyId, projectId);
    },
  );

  /**
   * EXECUTE — admin only, and the only route in the module that moves three
   * ledgers at once. Everything it writes is inside one transaction: a change
   * order that raised the contract sum but failed to move the budget would be
   * worse than one that never executed at all.
   */
  app.post(
    "/projects/:projectId/change-order-packages/:pkgId/execute",
    { preHandler: gates.admin },
    async (req) => {
      const { pkgId } = req.params as { pkgId: string };
      const body = executeSchema.parse(req.body ?? {});
      const companyId = companyOf(req);
      const projectId = projectOf(req);
      const actorId = actorOf(req);
      const pkg = await fetchPackage(app.db, pkgId, companyId, projectId);
      assertTransition(pkg.status, ["approved"], "change order package", "execute");
      if (body.expectedAmount !== undefined && Math.abs(body.expectedAmount - pkg.amount) > 0.005) {
        throw conflict(
          `You are executing ${pkg.reference} at ${pkg.amount.toFixed(2)} but expected ` +
            `${body.expectedAmount.toFixed(2)}. The package has moved since you read it — reload it ` +
            "before signing.",
        );
      }
      const ctx = { db: app.db, companyId, projectId, actorId };
      const options = {
        signedDate: body.signedDate ?? null,
        executedDate: body.executedDate ?? null,
      };
      const result =
        pkg.kind === "prime_contract"
          ? await executePrimePackage(ctx, pkg, options)
          : await executeCommitmentPackage(ctx, pkg, options);

      // Change events see the executed number, not the asked-for one.
      const eventIds = new Set<string>();
      if (pkg.changeEventId) eventIds.add(pkg.changeEventId);
      if (pkg.memberIds.length > 0) {
        if (pkg.kind === "prime_contract") {
          const rows = await app.db
            .select({ changeEventId: changeOrderRequests.changeEventId })
            .from(changeOrderRequests)
            .where(inArray(changeOrderRequests.id, pkg.memberIds));
          for (const r of rows) if (r.changeEventId) eventIds.add(r.changeEventId);
        } else {
          const rows = await app.db
            .select({ changeEventId: potentialChangeOrders.changeEventId })
            .from(potentialChangeOrders)
            .where(inArray(potentialChangeOrders.id, pkg.memberIds));
          for (const r of rows) if (r.changeEventId) eventIds.add(r.changeEventId);
        }
      }
      for (const eventId of eventIds) await recomputeEventRollup(app.db, eventId);

      await ledgerChange(
        app.db,
        req,
        "state_change",
        "change_order_package",
        pkgId,
        {
          reference: pkg.reference,
          from: pkg.status,
          to: "executed",
          kind: pkg.kind,
          amount: result.amount,
          currency: result.currency,
          allocationScale: result.scale,
          primeContractChangeId: result.primeContractChangeId,
          commitmentChangeId: result.commitmentChangeId,
          budgetChangeId: result.budget.budgetChangeId,
          contractSums: result.contractSums,
          commitmentSums: result.commitmentSums,
          budgetLinesMoved: result.budget.linesMoved,
          legs: result.legs,
          identities: result.identities,
          executedBy: actorId,
          approvedBy: pkg.approvedBy,
        },
        { storePayload: true },
      );
      if (result.primeContractChangeId) {
        await ledgerChange(app.db, req, "create", "prime_contract_change", result.primeContractChangeId, {
          reference: result.primeContractChangeReference,
          changeOrderPackageId: pkgId,
          amount: result.amount,
          revisedContractSum: result.contractSums?.revisedContractSum ?? null,
        });
      }
      if (result.commitmentChangeId) {
        await ledgerChange(app.db, req, "create", "commitment_change", result.commitmentChangeId, {
          reference: result.commitmentChangeReference,
          changeOrderPackageId: pkgId,
          amount: result.amount,
          revisedCommitmentSum: result.commitmentSums?.revisedCommitmentSum ?? null,
        });
      }
      if (result.budget.budgetChangeId) {
        await ledgerChange(app.db, req, "create", "budget_change", result.budget.budgetChangeId, {
          budgetId: result.budget.budgetId,
          kind: "owner_change",
          sourceType: "change_order_package",
          sourceId: pkgId,
          netEffect: result.amount,
          linesMoved: result.budget.linesMoved,
        });
      }

      return {
        package: await fetchPackage(app.db, pkgId, companyId, projectId),
        execution: result,
      };
    },
  );
};

